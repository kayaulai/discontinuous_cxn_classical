"""
collocation_classifier.py
==========================

Semi-supervised discovery of new character-pair collocations in Classical /
Ancient Chinese, using contextual embeddings from `jihuai/bert-ancient-chinese`.

WORKFLOW
--------
1. You supply two labeled sets, each mapping a character pair -> example
   sentences in which that pair occurs:
       - `confident_collocations`      (label = 1)
       - `confident_non_collocations`  (label = 0)
   and one unlabeled set:
       - `remaining_pairs`             (label = unknown, to be scored)

2. The labeled pairs are split at the PAIR level (not the example level)
   into train/validation, so validation measures generalization to *unseen
   pairs* -- which is exactly the regime we need, since ultimately we apply
   the model to brand-new pairs it has never seen.

3. A classification head is trained on top of BERT representations of the
   two target characters in context. The BERT backbone can be fully frozen
   (fast, acts like a fixed feature extractor + logistic/MLP probe) or
   partially fine-tuned by unfreezing just the last `Config.unfreeze_layers`
   transformer layers (0 = fully frozen; 1-3 is usually plenty for a small
   labeled set and much cheaper/safer than fine-tuning the whole model).

   `optuna_search()` can tune `unfreeze_layers`, the head learning rate,
   the backbone learning rate, the head's hidden size, and dropout for you.

   An alternative model, `AttentionCollocationClassifier` (used via
   `run_pipeline_attention` / `AttentionConfig`), always keeps BERT fully
   frozen and instead classifies from the cross-attention weights BERT
   assigns between the two target tokens -- both directions, every head of
   every layer -- with an explicit L2 penalty on the classifier head's
   weights.

4. The trained model scores every example of every "remaining" pair with
   P(collocation).

5. A confidence threshold is calibrated from the VALIDATION confident
   collocations: the threshold is the confidence of the *least confident*
   confident collocation (min over held-out collocation pairs of their
   mean/median predicted P(collocation)). Held-out pairs are used rather
   than training pairs to avoid the optimism bias of scoring examples the
   model was trained on.

6. A "remaining" pair is flagged as a NEWLY DETECTED COLLOCATION if at
   least `min_fraction` of its examples are scored with confidence >= that
   threshold.

Install:
    pip install torch transformers --break-system-packages

Usage example is at the bottom of this file (`if __name__ == "__main__"`).
"""

from __future__ import annotations

import random
import warnings
from collections import defaultdict
from dataclasses import dataclass, field, replace
from typing import Dict, List, Optional, Sequence, Tuple, Union

import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import DataLoader, Dataset

try:
    from transformers import AutoModel, AutoTokenizer
except ImportError as e:  # pragma: no cover
    raise ImportError(
        "This script needs `transformers` and `torch`. "
        "Install with: pip install torch transformers --break-system-packages"
    ) from e


MODEL_NAME = "jihuai/bert-ancient-chinese"
DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")

Pair = Tuple[str, str]


# ---------------------------------------------------------------------------
# 1. Data structures
# ---------------------------------------------------------------------------

@dataclass
class Example:
    """One occurrence of a character pair inside a sentence / context window."""

    sentence: str
    i: int  # character index of the first component within `sentence`
    j: int  # character index of the second component within `sentence`
    pair: Pair = field(default=None)  # type: ignore[assignment]
    label: Optional[int] = None  # 1 = collocation, 0 = non-collocation, None = unknown

    def __post_init__(self):
        if self.pair is None:
            self.pair = (self.sentence[self.i], self.sentence[self.j])
        assert self.sentence[self.i] == self.pair[0], "index i does not match pair[0]"
        assert self.sentence[self.j] == self.pair[1], "index j does not match pair[1]"


RawExample = Union[str, Dict[str, Union[str, int]]]
# A raw example is either:
#   - a plain sentence string (positions are auto-located), or
#   - a dict like {"sentence": "...", "i": 3, "j": 5}


def _find_closest_occurrence(sentence: str, c1: str, c2: str) -> Optional[Tuple[int, int]]:
    """Find the (i, j) occurrence of c1, c2 in `sentence` with the smallest
    character distance between them. Returns None if no occurrence exists."""
    idx1 = [k for k, ch in enumerate(sentence) if ch == c1]
    idx2 = [k for k, ch in enumerate(sentence) if ch == c2]
    best = None
    best_dist = None
    for i in idx1:
        for j in idx2:
            if i == j:
                continue
            dist = abs(i - j)
            if best_dist is None or dist < best_dist:
                best_dist = dist
                best = (i, j)
    return best


def build_examples(
    pair_examples: Dict[Pair, Sequence[RawExample]],
    label: Optional[int],
) -> List[Example]:
    """Turn {pair: [sentence_or_dict, ...]} into a flat list of Example objects.

    If a raw example is a plain string, the character positions are located
    automatically (closest co-occurrence heuristic). If you already know the
    exact positions (recommended, since you extracted these pairs
    computationally), pass dicts with explicit 'i' / 'j' instead.
    """
    out: List[Example] = []
    skipped = 0
    for (c1, c2), raws in pair_examples.items():
        for raw in raws:
            if isinstance(raw, dict):
                sentence = raw["sentence"]
                i, j = raw["i"], raw["j"]
            else:
                sentence = raw
                found = _find_closest_occurrence(sentence, c1, c2)
                if found is None:
                    skipped += 1
                    continue
                i, j = found
            out.append(Example(sentence=sentence, i=i, j=j, pair=(c1, c2), label=label))
    if skipped:
        warnings.warn(f"Skipped {skipped} example(s) where the pair could not be located.")
    return out


# ---------------------------------------------------------------------------
# 2. Train / validation split at the PAIR level (avoid leakage)
# ---------------------------------------------------------------------------

def split_pairs_train_val(
    pairs: Sequence[Pair], val_frac: float = 0.2, seed: int = 0
) -> Tuple[List[Pair], List[Pair]]:
    pairs = list(pairs)
    rng = random.Random(seed)
    rng.shuffle(pairs)
    n_val = max(1, int(round(len(pairs) * val_frac))) if len(pairs) > 1 else 0
    val_pairs = pairs[:n_val]
    train_pairs = pairs[n_val:]
    return train_pairs, val_pairs


def filter_examples_by_pairs(examples: List[Example], pairs: Sequence[Pair]) -> List[Example]:
    pairset = set(pairs)
    return [ex for ex in examples if ex.pair in pairset]


# ---------------------------------------------------------------------------
# 3. Tokenization: map a character index to a token index
# ---------------------------------------------------------------------------

def char_to_token_index(
    tokenizer, encoding, char_idx: int, sentence: str, is_fast: bool
) -> int:
    """Map a character index in `sentence` to the corresponding token index
    in `encoding['input_ids']` (which includes special tokens)."""
    if is_fast:
        offsets = encoding["offset_mapping"]
        for tok_idx, (start, end) in enumerate(offsets):
            if start == end:  # special tokens have (0, 0)
                continue
            if start <= char_idx < end:
                return tok_idx
        # fall through if not found (e.g. char_idx beyond truncation)
    # Slow-tokenizer / fallback path: count tokens in the prefix.
    # Ancient/classical Chinese BERT tokenizers are essentially char-level,
    # so this is a safe approximation even without offset mappings.
    prefix_ids = tokenizer(sentence[:char_idx], add_special_tokens=False)["input_ids"]
    return 1 + len(prefix_ids)  # +1 accounts for the leading [CLS]


class PairDataset(Dataset):
    def __init__(self, examples: List[Example], tokenizer, max_length: int = 128):
        self.examples = examples
        self.tokenizer = tokenizer
        self.max_length = max_length
        self.is_fast = getattr(tokenizer, "is_fast", False)

    def __len__(self):
        return len(self.examples)

    def __getitem__(self, idx):
        ex = self.examples[idx]
        enc = self.tokenizer(
            ex.sentence,
            truncation=True,
            max_length=self.max_length,
            return_offsets_mapping=self.is_fast,
        )
        n_tokens = len(enc["input_ids"])
        pos1 = min(
            char_to_token_index(self.tokenizer, enc, ex.i, ex.sentence, self.is_fast),
            n_tokens - 1,
        )
        pos2 = min(
            char_to_token_index(self.tokenizer, enc, ex.j, ex.sentence, self.is_fast),
            n_tokens - 1,
        )
        return {
            "input_ids": enc["input_ids"],
            "attention_mask": enc["attention_mask"],
            "pos1": pos1,
            "pos2": pos2,
            "label": ex.label if ex.label is not None else -1,
        }


def make_collate_fn(pad_token_id: int):
    def collate_fn(batch):
        max_len = max(len(x["input_ids"]) for x in batch)
        B = len(batch)
        input_ids = torch.full((B, max_len), pad_token_id, dtype=torch.long)
        attention_mask = torch.zeros((B, max_len), dtype=torch.long)
        pos1 = torch.zeros(B, dtype=torch.long)
        pos2 = torch.zeros(B, dtype=torch.long)
        labels = torch.zeros(B, dtype=torch.long)
        for k, x in enumerate(batch):
            L = len(x["input_ids"])
            input_ids[k, :L] = torch.tensor(x["input_ids"], dtype=torch.long)
            attention_mask[k, :L] = torch.tensor(x["attention_mask"], dtype=torch.long)
            pos1[k] = x["pos1"]
            pos2[k] = x["pos2"]
            labels[k] = x["label"]
        return {
            "input_ids": input_ids,
            "attention_mask": attention_mask,
            "pos1": pos1,
            "pos2": pos2,
            "labels": labels,
        }

    return collate_fn


# ---------------------------------------------------------------------------
# 4. Model
# ---------------------------------------------------------------------------

class CollocationClassifier(nn.Module):
    """BERT encoder + a small MLP head over the two target-character
    representations.

    `unfreeze_layers` controls how much of the backbone is trainable:
        - 0            : fully frozen backbone (pure feature extractor;
                          only the classifier head is trained).
        - 1..N         : only the LAST `unfreeze_layers` transformer encoder
                          layers are trainable (embeddings and earlier
                          layers stay frozen). This is usually enough to
                          adapt BERT to the task without the cost/overfitting
                          risk of fine-tuning the whole model on a small
                          labeled set.
    """

    def __init__(
        self,
        model_name: str = MODEL_NAME,
        unfreeze_layers: int = 0,
        hidden_dim: int = 256,
        dropout: float = 0.1,
    ):
        super().__init__()
        self.backbone = AutoModel.from_pretrained(model_name)
        self.unfreeze_layers = unfreeze_layers
        self._apply_freezing(unfreeze_layers)

        h = self.backbone.config.hidden_size
        # features: emb1, emb2, |emb1-emb2|, emb1*emb2
        self.classifier = nn.Sequential(
            nn.Linear(h * 4, hidden_dim),  # hidden_dim is tunable (Config.hidden_dim)
            nn.ReLU(),
            nn.Dropout(dropout),
            nn.Linear(hidden_dim, 2),
        )

    def _get_encoder_layers(self):
        # Standard BERT-style architecture (jihuai/bert-ancient-chinese is a
        # BertModel under the hood): backbone.encoder.layer is a ModuleList.
        if hasattr(self.backbone, "encoder") and hasattr(self.backbone.encoder, "layer"):
            return list(self.backbone.encoder.layer)
        raise AttributeError(
            "Could not locate transformer encoder layers on the backbone "
            "(expected `backbone.encoder.layer`). Inspect `model.backbone` "
            "and adjust `_get_encoder_layers` for this architecture."
        )

    @property
    def num_backbone_layers(self) -> int:
        return len(self._get_encoder_layers())

    def _apply_freezing(self, unfreeze_layers: int) -> None:
        # Start fully frozen (embeddings + all encoder layers + pooler).
        for p in self.backbone.parameters():
            p.requires_grad = False
        if unfreeze_layers <= 0:
            return
        encoder_layers = self._get_encoder_layers()
        n = len(encoder_layers)
        k = min(unfreeze_layers, n)
        if k < unfreeze_layers:
            warnings.warn(
                f"Requested unfreeze_layers={unfreeze_layers} but the backbone "
                f"only has {n} layers; unfreezing all {n}."
            )
        # Only the LAST k layers become trainable; embeddings and the
        # earlier layers stay frozen.
        for layer in encoder_layers[n - k:]:
            for p in layer.parameters():
                p.requires_grad = True

    def trainable_backbone_parameters(self) -> List[nn.Parameter]:
        return [p for p in self.backbone.parameters() if p.requires_grad]

    def forward(self, input_ids, attention_mask, pos1, pos2):
        if self.unfreeze_layers <= 0:
            # Nothing in the backbone needs gradients: run under no_grad to
            # save memory/compute.
            with torch.no_grad():
                out = self.backbone(input_ids=input_ids, attention_mask=attention_mask)
        else:
            # Autograd naturally stops backpropagating once it reaches the
            # first frozen layer, so this only pays for gradients through
            # the unfrozen (last-k) layers even though forward runs through
            # the whole stack.
            out = self.backbone(input_ids=input_ids, attention_mask=attention_mask)
        hidden = out.last_hidden_state  # (B, L, H)
        batch_idx = torch.arange(hidden.size(0), device=hidden.device)
        emb1 = hidden[batch_idx, pos1]
        emb2 = hidden[batch_idx, pos2]
        feat = torch.cat([emb1, emb2, torch.abs(emb1 - emb2), emb1 * emb2], dim=-1)
        logits = self.classifier(feat)
        return logits


# ---------------------------------------------------------------------------
# 5. Config
# ---------------------------------------------------------------------------

@dataclass
class Config:
    model_name: str = MODEL_NAME
    unfreeze_layers: int = 0              # hyperparameter: 0 = frozen backbone,
                                           # k>0 = fine-tune only the last k encoder layers
    hidden_dim: int = 256                 # hyperparameter: classifier head width
    dropout: float = 0.1                  # hyperparameter: classifier head dropout
    max_length: int = 128
    batch_size: int = 16
    epochs: int = 10
    lr_head: float = 1e-3                 # hyperparameter: classifier head LR
    lr_backbone: float = 2e-5             # hyperparameter: backbone LR (only used if unfreeze_layers > 0)
    weight_decay: float = 0.01
    val_frac: float = 0.2
    seed: int = 0
    min_fraction: float = 0.5             # % of examples needed to flag a new collocation
    reference_agg: str = "mean"           # "mean" or "median" per-pair aggregation
    early_stopping_patience: int = 3


# ---------------------------------------------------------------------------
# 6. Training
# ---------------------------------------------------------------------------

def train_classifier(
    train_examples: List[Example],
    val_examples: List[Example],
    cfg: Config,
    tokenizer=None,
) -> Tuple[CollocationClassifier, "AutoTokenizer", float]:
    random.seed(cfg.seed)
    np.random.seed(cfg.seed)
    torch.manual_seed(cfg.seed)

    if tokenizer is None:
        tokenizer = AutoTokenizer.from_pretrained(cfg.model_name)

    model = CollocationClassifier(
        model_name=cfg.model_name,
        unfreeze_layers=cfg.unfreeze_layers,
        hidden_dim=cfg.hidden_dim,
        dropout=cfg.dropout,
    ).to(DEVICE)

    collate_fn = make_collate_fn(tokenizer.pad_token_id)
    train_ds = PairDataset(train_examples, tokenizer, cfg.max_length)
    val_ds = PairDataset(val_examples, tokenizer, cfg.max_length)
    train_loader = DataLoader(train_ds, batch_size=cfg.batch_size, shuffle=True, collate_fn=collate_fn)
    val_loader = DataLoader(val_ds, batch_size=cfg.batch_size, shuffle=False, collate_fn=collate_fn)

    # class weights to handle imbalance
    labels = np.array([ex.label for ex in train_examples])
    n_pos = max(1, (labels == 1).sum())
    n_neg = max(1, (labels == 0).sum())
    total = n_pos + n_neg
    class_weights = torch.tensor(
        [total / (2 * n_neg), total / (2 * n_pos)], dtype=torch.float, device=DEVICE
    )
    criterion = nn.CrossEntropyLoss(weight=class_weights)

    trainable_backbone_params = model.trainable_backbone_parameters()
    if not trainable_backbone_params:
        # unfreeze_layers == 0: pure feature extractor, only train the head.
        optimizer = torch.optim.AdamW(
            model.classifier.parameters(), lr=cfg.lr_head, weight_decay=cfg.weight_decay
        )
    else:
        # unfreeze_layers > 0: discriminative learning rates -- a small LR
        # for the (few) unfrozen backbone layers, a larger LR for the head.
        optimizer = torch.optim.AdamW(
            [
                {"params": trainable_backbone_params, "lr": cfg.lr_backbone},
                {"params": model.classifier.parameters(), "lr": cfg.lr_head},
            ],
            weight_decay=cfg.weight_decay,
        )

    best_val_acc = -1.0
    best_state = None
    patience = 0

    for epoch in range(cfg.epochs):
        model.train()
        total_loss = 0.0
        for batch in train_loader:
            batch = {k: v.to(DEVICE) for k, v in batch.items()}
            optimizer.zero_grad()
            logits = model(batch["input_ids"], batch["attention_mask"], batch["pos1"], batch["pos2"])
            loss = criterion(logits, batch["labels"])
            loss.backward()
            optimizer.step()
            total_loss += loss.item() * batch["labels"].size(0)
        train_loss = total_loss / max(1, len(train_ds))

        val_acc, val_loss = evaluate(model, val_loader, criterion)
        print(
            f"epoch {epoch+1}/{cfg.epochs}  train_loss={train_loss:.4f}  "
            f"val_loss={val_loss:.4f}  val_acc={val_acc:.4f}"
        )

        if val_acc > best_val_acc:
            best_val_acc = val_acc
            best_state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
            patience = 0
        else:
            patience += 1
            if patience >= cfg.early_stopping_patience:
                print("Early stopping.")
                break

    if best_state is not None:
        model.load_state_dict(best_state)
    model.to(DEVICE)
    return model, tokenizer, best_val_acc


@torch.no_grad()
def evaluate(model, loader, criterion) -> Tuple[float, float]:
    model.eval()
    correct, total, loss_sum = 0, 0, 0.0
    for batch in loader:
        batch = {k: v.to(DEVICE) for k, v in batch.items()}
        logits = model(batch["input_ids"], batch["attention_mask"], batch["pos1"], batch["pos2"])
        loss = criterion(logits, batch["labels"])
        loss_sum += loss.item() * batch["labels"].size(0)
        preds = logits.argmax(dim=-1)
        correct += (preds == batch["labels"]).sum().item()
        total += batch["labels"].size(0)
    return correct / max(1, total), loss_sum / max(1, total)


# ---------------------------------------------------------------------------
# 6b. Hyperparameter search with optuna
# ---------------------------------------------------------------------------

def optuna_search(
    train_examples: List[Example],
    val_examples: List[Example],
    base_cfg: Optional[Config] = None,
    n_trials: int = 20,
    max_unfreeze_layers: Optional[int] = 3,
    lr_backbone_range: Tuple[float, float] = (1e-6, 5e-5),
    lr_head_range: Tuple[float, float] = (1e-4, 5e-3),
    hidden_dim_choices: Sequence[int] = (128, 256, 512),
    dropout_range: Tuple[float, float] = (0.0, 0.5),
    tokenizer=None,
):
    """Tune, via optuna: how many BERT layers to unfreeze (0..max_unfreeze_layers,
    default cap of 3 as requested), the classifier-head learning rate, the
    BERT fine-tuning learning rate, the head's hidden size, and dropout.

    Each trial trains a fresh model from the pretrained checkpoint (so
    trials don't leak into each other) and is scored on validation accuracy
    from `train_classifier`, which already does pair-level held-out
    validation and early stopping.

    Returns the completed `optuna.study.Study`; the winning hyperparameters
    are in `study.best_trial.params` and can be merged into a Config with
    `dataclasses.replace(base_cfg, **study.best_trial.params)`.
    """
    try:
        import optuna
    except ImportError as e:
        raise ImportError(
            "optuna is required for hyperparameter search: "
            "pip install optuna --break-system-packages"
        ) from e

    base_cfg = base_cfg or Config()

    if tokenizer is None:
        tokenizer = AutoTokenizer.from_pretrained(base_cfg.model_name)

    if max_unfreeze_layers is None:
        probe = AutoModel.from_pretrained(base_cfg.model_name)
        max_unfreeze_layers = probe.config.num_hidden_layers
        del probe

    def objective(trial: "optuna.trial.Trial") -> float:
        unfreeze_layers = trial.suggest_int("unfreeze_layers", 0, max_unfreeze_layers)
        lr_head = trial.suggest_float("lr_head", *lr_head_range, log=True)
        hidden_dim = trial.suggest_categorical("hidden_dim", list(hidden_dim_choices))
        dropout = trial.suggest_float("dropout", *dropout_range)
        # lr_backbone is only meaningful once we actually unfreeze something;
        # only sample/search over it in that case, otherwise keep the base
        # config's value (it will simply go unused this trial).
        if unfreeze_layers > 0:
            lr_backbone = trial.suggest_float("lr_backbone", *lr_backbone_range, log=True)
        else:
            lr_backbone = base_cfg.lr_backbone

        trial_cfg = replace(
            base_cfg,
            unfreeze_layers=unfreeze_layers,
            lr_head=lr_head,
            lr_backbone=lr_backbone,
            hidden_dim=hidden_dim,
            dropout=dropout,
        )

        _, _, val_acc = train_classifier(train_examples, val_examples, trial_cfg, tokenizer=tokenizer)
        return val_acc

    study = optuna.create_study(direction="maximize")
    study.optimize(objective, n_trials=n_trials)
    print("Best trial params:", study.best_trial.params)
    print("Best val_acc:", study.best_value)
    return study


# ---------------------------------------------------------------------------
# 7. Inference + aggregation
# ---------------------------------------------------------------------------

@torch.no_grad()
def predict_proba(
    model: CollocationClassifier,
    examples: List[Example],
    tokenizer,
    batch_size: int = 32,
    max_length: int = 128,
) -> List[float]:
    """Returns P(collocation) for each example, in the same order as `examples`."""
    model.eval()
    ds = PairDataset(examples, tokenizer, max_length)
    collate_fn = make_collate_fn(tokenizer.pad_token_id)
    loader = DataLoader(ds, batch_size=batch_size, shuffle=False, collate_fn=collate_fn)
    probs: List[float] = []
    for batch in loader:
        batch = {k: v.to(DEVICE) for k, v in batch.items()}
        logits = model(batch["input_ids"], batch["attention_mask"], batch["pos1"], batch["pos2"])
        p = torch.softmax(logits, dim=-1)[:, 1]
        probs.extend(p.cpu().tolist())
    return probs


@dataclass
class PairStats:
    pair: Pair
    n: int
    mean_prob: float
    median_prob: float
    frac_classified_collocation: float  # fraction with p >= 0.5


def aggregate_by_pair(examples: List[Example], probs: List[float]) -> Dict[Pair, PairStats]:
    by_pair: Dict[Pair, List[float]] = defaultdict(list)
    for ex, p in zip(examples, probs):
        by_pair[ex.pair].append(p)
    stats: Dict[Pair, PairStats] = {}
    for pair, plist in by_pair.items():
        arr = np.asarray(plist, dtype=float)
        stats[pair] = PairStats(
            pair=pair,
            n=len(arr),
            mean_prob=float(arr.mean()),
            median_prob=float(np.median(arr)),
            frac_classified_collocation=float((arr >= 0.5).mean()),
        )
    return stats


# ---------------------------------------------------------------------------
# 8. Threshold calibration + new-collocation detection
# ---------------------------------------------------------------------------

def compute_reference_threshold(
    val_collocation_stats: Dict[Pair, PairStats], agg: str = "mean"
) -> float:
    """The confidence of the LEAST confident held-out confident-collocation
    pair. This is the floor a "remaining" pair's examples must clear to be
    counted as confidently-classified-as-collocation."""
    key = "mean_prob" if agg == "mean" else "median_prob"
    values = [getattr(s, key) for s in val_collocation_stats.values()]
    if not values:
        raise ValueError("No held-out confident-collocation pairs to calibrate against.")
    return min(values)


def detect_new_collocations(
    remaining_examples: List[Example],
    remaining_probs: List[float],
    reference_threshold: float,
    min_fraction: float = 0.5,
) -> Dict[Pair, Dict]:
    """For each remaining pair, compute the fraction of its examples whose
    P(collocation) is at least as high as `reference_threshold`. Flag the
    pair as a newly detected collocation if that fraction >= min_fraction."""
    by_pair: Dict[Pair, List[float]] = defaultdict(list)
    for ex, p in zip(remaining_examples, remaining_probs):
        by_pair[ex.pair].append(p)

    results: Dict[Pair, Dict] = {}
    for pair, plist in by_pair.items():
        arr = np.asarray(plist, dtype=float)
        frac_confident = float((arr >= reference_threshold).mean())
        results[pair] = {
            "n": len(arr),
            "mean_prob": float(arr.mean()),
            "median_prob": float(np.median(arr)),
            "frac_at_least_reference_confidence": frac_confident,
            "frac_classified_collocation": float((arr >= 0.5).mean()),
            "is_detected_collocation": frac_confident >= min_fraction,
        }
    return results


# ---------------------------------------------------------------------------
# 9. End-to-end pipeline
# ---------------------------------------------------------------------------

def run_pipeline(
    confident_collocations: Dict[Pair, Sequence[RawExample]],
    confident_non_collocations: Dict[Pair, Sequence[RawExample]],
    remaining_pairs: Dict[Pair, Sequence[RawExample]],
    cfg: Optional[Config] = None,
    use_optuna: bool = False,
    n_trials: int = 20,
    optuna_kwargs: Optional[Dict] = None,
):
    """Set `use_optuna=True` to first run `optuna_search` over
    (unfreeze_layers, lr_head, lr_backbone, hidden_dim, dropout) on the
    train/val split, then train the final model with the winning config."""
    cfg = cfg or Config()

    colloc_examples = build_examples(confident_collocations, label=1)
    non_colloc_examples = build_examples(confident_non_collocations, label=0)
    remaining_examples = build_examples(remaining_pairs, label=None)

    colloc_pairs = list(confident_collocations.keys())
    non_colloc_pairs = list(confident_non_collocations.keys())

    train_colloc_pairs, val_colloc_pairs = split_pairs_train_val(
        colloc_pairs, cfg.val_frac, cfg.seed
    )
    train_non_pairs, val_non_pairs = split_pairs_train_val(
        non_colloc_pairs, cfg.val_frac, cfg.seed + 1
    )

    train_examples = filter_examples_by_pairs(colloc_examples, train_colloc_pairs) + \
        filter_examples_by_pairs(non_colloc_examples, train_non_pairs)
    val_examples = filter_examples_by_pairs(colloc_examples, val_colloc_pairs) + \
        filter_examples_by_pairs(non_colloc_examples, val_non_pairs)

    print(f"Train: {len(train_examples)} examples over "
          f"{len(train_colloc_pairs)+len(train_non_pairs)} pairs")
    print(f"Val:   {len(val_examples)} examples over "
          f"{len(val_colloc_pairs)+len(val_non_pairs)} pairs")

    if use_optuna:
        study = optuna_search(
            train_examples, val_examples, base_cfg=cfg, n_trials=n_trials,
            **(optuna_kwargs or {}),
        )
        best_params = {
            k: v for k, v in study.best_trial.params.items() if k in cfg.__dataclass_fields__
        }
        cfg = replace(cfg, **best_params)
        print(f"Using optuna-selected config: {cfg}")

    model, tokenizer, best_val_acc = train_classifier(train_examples, val_examples, cfg)
    print(f"Final model validation accuracy: {best_val_acc:.4f}")

    # Calibrate the reference threshold using held-out (validation) confident
    # collocations only -- these were NOT trained on, so their predicted
    # confidence is a fair estimate of generalization confidence.
    val_colloc_examples = filter_examples_by_pairs(colloc_examples, val_colloc_pairs)
    val_colloc_probs = predict_proba(model, val_colloc_examples, tokenizer, cfg.batch_size, cfg.max_length)
    val_colloc_stats = aggregate_by_pair(val_colloc_examples, val_colloc_probs)
    reference_threshold = compute_reference_threshold(val_colloc_stats, agg=cfg.reference_agg)
    print(f"Reference confidence threshold (least-confident held-out "
          f"confident collocation): {reference_threshold:.4f}")

    # Score the remaining (unlabeled) pairs.
    remaining_probs = predict_proba(model, remaining_examples, tokenizer, cfg.batch_size, cfg.max_length)
    detection_results = detect_new_collocations(
        remaining_examples, remaining_probs, reference_threshold, cfg.min_fraction
    )

    detected = {p: r for p, r in detection_results.items() if r["is_detected_collocation"]}
    print(f"Detected {len(detected)} new collocation(s) out of {len(detection_results)} candidate pairs.")

    return {
        "model": model,
        "tokenizer": tokenizer,
        "reference_threshold": reference_threshold,
        "val_confident_collocation_stats": val_colloc_stats,
        "remaining_pair_results": detection_results,
        "detected_collocations": detected,
    }


# ---------------------------------------------------------------------------
# 10. Alternative model: frozen-BERT ATTENTION features
# ---------------------------------------------------------------------------
#
# Instead of classifying from the two target characters' hidden-state
# embeddings, this model classifies from the cross-attention weight BERT
# places between the two token positions -- in both directions, from every
# head of every layer. The intuition: collocated words should show a
# systematically different attention pattern to each other than
# non-collocated words, and different heads/layers may pick up on different
# kinds of association (syntactic, semantic, positional, ...).
#
# The BERT backbone is always frozen here (attention patterns are only
# meaningfully comparable across examples if the model producing them isn't
# changing), so only the small classifier head is trained. We add an
# explicit L2 penalty on the classifier head's weight matrices (in addition
# to / instead of AdamW's decoupled weight decay) as a regularizer, since
# the feature vector (num_layers * num_heads * 2) can be fairly large
# relative to the amount of labeled data.

class AttentionCollocationClassifier(nn.Module):
    """Classifies a (char_i, char_j) pair from BERT's cross-attention
    weights between their token positions, pooled over every (layer, head).

    Feature vector per example = concat over all layers and heads of:
        - attention(i -> j): how much token i attends to token j
        - attention(j -> i): how much token j attends to token i
    -> size = num_layers * num_heads * 2.

    The backbone is ALWAYS frozen (no unfreeze option) -- it is only ever
    used to read off attention weights, never fine-tuned.
    """

    def __init__(
        self,
        model_name: str = MODEL_NAME,
        hidden_dim: int = 256,   # tunable classifier head width
        dropout: float = 0.1,
    ):
        super().__init__()
        try:
            # `attn_implementation="eager"` guarantees attentions are
            # actually materialized and returned (some SDPA/flash-attention
            # backends skip computing them for speed).
            self.backbone = AutoModel.from_pretrained(model_name, attn_implementation="eager")
        except TypeError:
            # Older `transformers` versions don't accept this kwarg.
            self.backbone = AutoModel.from_pretrained(model_name)

        for p in self.backbone.parameters():
            p.requires_grad = False
        self.backbone.eval()

        self.n_layers = self.backbone.config.num_hidden_layers
        self.n_heads = self.backbone.config.num_attention_heads
        feat_dim = self.n_layers * self.n_heads * 2

        self.classifier = nn.Sequential(
            nn.Linear(feat_dim, hidden_dim),
            nn.ReLU(),
            nn.Dropout(dropout),
            nn.Linear(hidden_dim, 2),
        )

    def train(self, mode: bool = True):
        # Keep the frozen backbone in eval() (dropout off, deterministic
        # attentions) no matter what mode the overall module is switched to.
        super().train(mode)
        self.backbone.eval()
        return self

    def extract_attention_features(self, input_ids, attention_mask, pos1, pos2) -> torch.Tensor:
        with torch.no_grad():
            out = self.backbone(
                input_ids=input_ids,
                attention_mask=attention_mask,
                output_attentions=True,
            )
        # out.attentions: tuple of length n_layers, each (B, n_heads, L, L)
        batch_idx = torch.arange(input_ids.size(0), device=input_ids.device)
        feats = []
        for layer_attn in out.attentions:
            a_i_to_j = layer_attn[batch_idx, :, pos1, pos2]  # (B, n_heads)
            a_j_to_i = layer_attn[batch_idx, :, pos2, pos1]  # (B, n_heads)
            feats.append(a_i_to_j)
            feats.append(a_j_to_i)
        return torch.cat(feats, dim=-1)  # (B, n_layers * n_heads * 2)

    def forward(self, input_ids, attention_mask, pos1, pos2):
        feat = self.extract_attention_features(input_ids, attention_mask, pos1, pos2)
        return self.classifier(feat)

    def l2_penalty(self) -> torch.Tensor:
        """Explicit L2 penalty over the classification head's weight
        matrices (biases excluded, as is standard practice)."""
        device = next(self.classifier.parameters()).device
        penalty = torch.zeros((), device=device)
        for module in self.classifier:
            if isinstance(module, nn.Linear):
                penalty = penalty + module.weight.pow(2).sum()
        return penalty


@dataclass
class AttentionConfig:
    model_name: str = MODEL_NAME
    hidden_dim: int = 256                 # hyperparameter: classifier head width
    dropout: float = 0.1                  # hyperparameter: classifier head dropout
    l2_lambda: float = 1e-3               # hyperparameter: explicit L2 penalty on head weights
    weight_decay: float = 0.0             # AdamW decoupled weight decay (kept separate from l2_lambda)
    max_length: int = 128
    batch_size: int = 16
    epochs: int = 10
    lr_head: float = 1e-3
    val_frac: float = 0.2
    seed: int = 0
    min_fraction: float = 0.5             # % of examples needed to flag a new collocation
    reference_agg: str = "mean"           # "mean" or "median" per-pair aggregation
    early_stopping_patience: int = 3


def train_attention_classifier(
    train_examples: List[Example],
    val_examples: List[Example],
    cfg: AttentionConfig,
    tokenizer=None,
) -> Tuple[AttentionCollocationClassifier, "AutoTokenizer", float]:
    random.seed(cfg.seed)
    np.random.seed(cfg.seed)
    torch.manual_seed(cfg.seed)

    if tokenizer is None:
        tokenizer = AutoTokenizer.from_pretrained(cfg.model_name)

    model = AttentionCollocationClassifier(
        model_name=cfg.model_name, hidden_dim=cfg.hidden_dim, dropout=cfg.dropout
    ).to(DEVICE)

    collate_fn = make_collate_fn(tokenizer.pad_token_id)
    train_ds = PairDataset(train_examples, tokenizer, cfg.max_length)
    val_ds = PairDataset(val_examples, tokenizer, cfg.max_length)
    train_loader = DataLoader(train_ds, batch_size=cfg.batch_size, shuffle=True, collate_fn=collate_fn)
    val_loader = DataLoader(val_ds, batch_size=cfg.batch_size, shuffle=False, collate_fn=collate_fn)

    # class weights to handle imbalance
    labels = np.array([ex.label for ex in train_examples])
    n_pos = max(1, (labels == 1).sum())
    n_neg = max(1, (labels == 0).sum())
    total = n_pos + n_neg
    class_weights = torch.tensor(
        [total / (2 * n_neg), total / (2 * n_pos)], dtype=torch.float, device=DEVICE
    )
    criterion = nn.CrossEntropyLoss(weight=class_weights)

    # Only the classifier head has trainable parameters (backbone is frozen).
    optimizer = torch.optim.AdamW(
        model.classifier.parameters(), lr=cfg.lr_head, weight_decay=cfg.weight_decay
    )

    best_val_acc = -1.0
    best_state = None
    patience = 0

    for epoch in range(cfg.epochs):
        model.train()
        total_loss = 0.0
        for batch in train_loader:
            batch = {k: v.to(DEVICE) for k, v in batch.items()}
            optimizer.zero_grad()
            logits = model(batch["input_ids"], batch["attention_mask"], batch["pos1"], batch["pos2"])
            ce_loss = criterion(logits, batch["labels"])
            loss = ce_loss + cfg.l2_lambda * model.l2_penalty()
            loss.backward()
            optimizer.step()
            total_loss += loss.item() * batch["labels"].size(0)
        train_loss = total_loss / max(1, len(train_ds))

        val_acc, val_loss = evaluate(model, val_loader, criterion)
        print(
            f"epoch {epoch+1}/{cfg.epochs}  train_loss={train_loss:.4f}  "
            f"val_loss={val_loss:.4f}  val_acc={val_acc:.4f}"
        )

        if val_acc > best_val_acc:
            best_val_acc = val_acc
            best_state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
            patience = 0
        else:
            patience += 1
            if patience >= cfg.early_stopping_patience:
                print("Early stopping.")
                break

    if best_state is not None:
        model.load_state_dict(best_state)
    model.to(DEVICE)
    return model, tokenizer, best_val_acc


def run_pipeline_attention(
    confident_collocations: Dict[Pair, Sequence[RawExample]],
    confident_non_collocations: Dict[Pair, Sequence[RawExample]],
    remaining_pairs: Dict[Pair, Sequence[RawExample]],
    cfg: Optional[AttentionConfig] = None,
):
    """Same end-to-end discovery pipeline as `run_pipeline`, but using the
    attention-feature model instead of the embedding-feature model. Reuses
    `predict_proba`, `aggregate_by_pair`, `compute_reference_threshold`, and
    `detect_new_collocations` unchanged, since those only depend on the
    model producing P(collocation) logits -- not on how it computes them."""
    cfg = cfg or AttentionConfig()

    colloc_examples = build_examples(confident_collocations, label=1)
    non_colloc_examples = build_examples(confident_non_collocations, label=0)
    remaining_examples = build_examples(remaining_pairs, label=None)

    colloc_pairs = list(confident_collocations.keys())
    non_colloc_pairs = list(confident_non_collocations.keys())

    train_colloc_pairs, val_colloc_pairs = split_pairs_train_val(
        colloc_pairs, cfg.val_frac, cfg.seed
    )
    train_non_pairs, val_non_pairs = split_pairs_train_val(
        non_colloc_pairs, cfg.val_frac, cfg.seed + 1
    )

    train_examples = filter_examples_by_pairs(colloc_examples, train_colloc_pairs) + \
        filter_examples_by_pairs(non_colloc_examples, train_non_pairs)
    val_examples = filter_examples_by_pairs(colloc_examples, val_colloc_pairs) + \
        filter_examples_by_pairs(non_colloc_examples, val_non_pairs)

    print(f"Train: {len(train_examples)} examples over "
          f"{len(train_colloc_pairs)+len(train_non_pairs)} pairs")
    print(f"Val:   {len(val_examples)} examples over "
          f"{len(val_colloc_pairs)+len(val_non_pairs)} pairs")

    model, tokenizer, best_val_acc = train_attention_classifier(train_examples, val_examples, cfg)
    print(f"Final model validation accuracy: {best_val_acc:.4f}")

    val_colloc_examples = filter_examples_by_pairs(colloc_examples, val_colloc_pairs)
    val_colloc_probs = predict_proba(model, val_colloc_examples, tokenizer, cfg.batch_size, cfg.max_length)
    val_colloc_stats = aggregate_by_pair(val_colloc_examples, val_colloc_probs)
    reference_threshold = compute_reference_threshold(val_colloc_stats, agg=cfg.reference_agg)
    print(f"Reference confidence threshold (least-confident held-out "
          f"confident collocation): {reference_threshold:.4f}")

    remaining_probs = predict_proba(model, remaining_examples, tokenizer, cfg.batch_size, cfg.max_length)
    detection_results = detect_new_collocations(
        remaining_examples, remaining_probs, reference_threshold, cfg.min_fraction
    )

    detected = {p: r for p, r in detection_results.items() if r["is_detected_collocation"]}
    print(f"Detected {len(detected)} new collocation(s) out of {len(detection_results)} candidate pairs.")

    return {
        "model": model,
        "tokenizer": tokenizer,
        "reference_threshold": reference_threshold,
        "val_confident_collocation_stats": val_colloc_stats,
        "remaining_pair_results": detection_results,
        "detected_collocations": detected,
    }


# ---------------------------------------------------------------------------
# 11. Example usage (edit / run this section with your real data)
# ---------------------------------------------------------------------------

import pandas as pd
if __name__ == "__main__":
    confident_pairs_df = pd.read_csv("../../output/02_measures/exp1_selected_df_2tail.csv")

    confident_pairs_df_repel = confident_pairs_df.loc[confident_pairs_df["pmi"] < 0]
    confident_non_collocations = [(dc, sfp) for (i, (dc, sfp, n, pmi)) in confident_pairs_df_repel.iterrows()]
    confident_pairs_df_attract = confident_pairs_df.loc[confident_pairs_df["pmi"] > 0]
    confident_collocations = [(dc, sfp) for (i, (dc, sfp, n, pmi)) in confident_pairs_df_attract.iterrows()]

    with open(r"..\..\output\01_extract_pairs\combosDF.csv", "r", encoding="utf-8") as in_file:
        combo_df = pd.read_csv(in_file)

    
    confident_collocation_sentences = dict()
    confident_non_collocation_sentences = dict()
    non_confident_sentences = dict()

    import tqdm
    for (i, item) in tqdm.tqdm(combo_df.iterrows()):
        if item["dc"] != item["dc"]:
            continue
        if item["sfp"] != item["sfp"]:
            continue

        curr_pair = (item["dc"], item["sfp"])
        if curr_pair in confident_collocations:
            confident_collocation_sentences[curr_pair] =\
                confident_collocation_sentences.get(curr_pair, []) + [item["sentence"]]

        elif curr_pair in confident_non_collocations:
            confident_non_collocation_sentences[curr_pair] =\
                confident_non_collocation_sentences.get(curr_pair, []) + [item["sentence"]]

        else:
            non_confident_sentences[curr_pair] =\
                non_confident_sentences.get(curr_pair, []) + [item["sentence"]]

    cfg = Config(
        unfreeze_layers=0,      # 0 = frozen backbone; try 1-3 to fine-tune just the top layers
        hidden_dim=256,         # tunable head width
        epochs=5,
        batch_size=8,
        min_fraction=0.5,
    )

    # Option A: train with a fixed config.
    # results = run_pipeline(
    #     confident_collocation_sentences, confident_non_collocation_sentences, non_confident_sentences, cfg
    # )

    # Option B: let optuna pick unfreeze_layers (capped at 3), lr_head,
    # lr_backbone, hidden_dim, and dropout for you, then train the final
    # model with the winning config. Requires `pip install optuna`.
    #
    # results = run_pipeline(
    #     confident_collocations, confident_non_collocations, remaining_pairs,
    #     cfg=cfg, use_optuna=True, n_trials=20,
    #     optuna_kwargs={"max_unfreeze_layers": 3},
    # )

    # Option C: the attention-feature model -- frozen BERT, classify from
    # cross-attention weights between the two characters (all layers/heads,
    # both directions) instead of from their hidden-state embeddings, with
    # an explicit L2 penalty on the classifier head's weights.
    #
    attn_cfg = AttentionConfig(hidden_dim=256, l2_lambda=1e-3, epochs=5, batch_size=8)
    results = run_pipeline_attention(
        confident_collocation_sentences, confident_non_collocation_sentences, non_confident_sentences, attn_cfg
    )

    for pair, info in results["detected_collocations"].items():
        print(pair, info)