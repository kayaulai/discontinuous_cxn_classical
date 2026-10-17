
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

Pair = Tuple[str, str]

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


def _find_begin_end(sentence: str, c1: str, c2: str) -> tuple[int, int]:
    """Find the first c1 and last c2 in a sentence."""
    i = sentence.index(c1)
    j = next(k for k in reversed(range(len(sentence))) if sentence[k] == c2)
    return (i, j)


def build_examples(
    pair_examples: dict[Pair, Sequence[RawExample]],
    label: int,
) -> list[Example]:
    """Turn {pair: [sentence_or_dict, ...]} into a flat list of Example objects.

    If a raw example is a plain string, the character positions are located
    automatically. If you already know the
    exact positions, pass dicts with explicit 'i' / 'j' instead.
    """
    out: list[Example] = []
    skipped = 0
    
    for (c1, c2), raws in pair_examples.items():
        c1 = c1.replace("尙", "尚").replace("竝", "並").replace("眞", "真").replace("愼", "慎")
        for raw in raws:
            if isinstance(raw, dict):
                sentence = raw["sentence"]
                i, j = raw["i"], raw["j"]
            else:
                
                sentence = raw
                try:
                    found = _find_begin_end(sentence, c1, c2)
                except ValueError:
                    found = None
                    print(f"({c1}, {c2}): {sentence}")
                if found is None:
                    skipped += 1
                    continue
                i, j = found
            out.append(Example(sentence=sentence, i=i, j=j, pair=(c1, c2), label=label))
    if skipped:
        warnings.warn(f"Skipped {skipped} example(s) where the pair could not be located.")
    return out
