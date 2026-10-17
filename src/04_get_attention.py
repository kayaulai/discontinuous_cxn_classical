"""
attention_correlation_analysis.py
===================================

Extract BERT cross-attention weights between two target characters (both
directions, every layer, every head) for every example, aggregate per
character pair, and correlate against your own corpus-linguistic
association measures (PMI, t-score, log-likelihood, log-Dice, MI, ...).

FEASIBILITY
-----------
You don't need the full L x L attention matrix per sentence for this --
just the two scalar attention weights between your target pair's token
positions (i->j and j->i), per layer, per head. For a standard BERT-base
architecture (12 layers x 12 heads):

    channels per example = 12 * 12 * 2 = 288
    5299 examples * 288 floats * 4 bytes (float32) ~= 6 MB

Trivially one file (.npy / .parquet / .csv), loads instantly, fits in
memory with room to spare. `extract_attention_dataset` below prints the
real n_layers/n_heads for whatever model you load, and
`estimate_storage_bytes` lets you plug in your own numbers if you're
unsure.

(If you ever DO want the full L x L matrix per head/layer instead of just
the pair positions -- e.g. to look at whole attention profiles rather than
a single cell -- that's roughly `n_examples * n_layers * n_heads * L^2`
floats, which for ~5300 sentences of length ~30-40 lands in the low
single-digit GB range. Still fine on disk, just no longer a casually-sized
single in-memory array, and you don't need it for pairwise correlations.)

Install:
    pip install torch transformers pandas scipy pyarrow --break-system-packages
    (pyarrow is only needed if you save/load .parquet)

This module reuses `Example`, `build_examples`, `PairDataset`,
`make_collate_fn` from collocation_classifier.py -- keep that file
alongside this one, or copy the relevant pieces in.
"""

from __future__ import annotations

from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np
import pandas as pd
import torch
from torch.utils.data import DataLoader
from transformers import AutoModel, AutoTokenizer

from utils.data_classes import (
    Example,
    Pair,
    PairDataset,
    RawExample,
    build_examples,
    make_collate_fn,
)


DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")
MODEL_NAME = "jihuai/bert-ancient-chinese"

# ---------------------------------------------------------------------------
# Feasibility helper
# ---------------------------------------------------------------------------

def estimate_storage_bytes(
    n_examples: int, n_layers: int, n_heads: int, dtype_bytes: int = 4
) -> int:
    """Bytes needed to store the (i->j, j->i) x (layer, head) attention
    features for `n_examples`, as a flat float array."""
    return n_examples * n_layers * n_heads * 2 * dtype_bytes


# ---------------------------------------------------------------------------
# 1. Extract per-example attention features
# ---------------------------------------------------------------------------

@torch.no_grad()
def extract_attention_dataset(
    examples: List[Example],
    model_name: str = MODEL_NAME,
    batch_size: int = 16,
    max_length: int = 128,
    tokenizer=None,
    model=None,
) -> Tuple[np.ndarray, List[str]]:
    """Run frozen BERT once over every example and pull out, for each
    layer and head, the attention weight from the first target token to
    the second (i->j) and from the second to the first (j->i).

    Returns
    -------
    features : float32 array of shape (n_examples, n_layers * n_heads * 2)
    channel_names : list[str] parallel to the columns, e.g. 'L0_H3_i2j'
    """
    if tokenizer is None:
        tokenizer = AutoTokenizer.from_pretrained(model_name)
    if model is None:
        try:
            model = AutoModel.from_pretrained(model_name, attn_implementation="eager")
        except TypeError:
            model = AutoModel.from_pretrained(model_name)
        model.to(DEVICE)
    model.eval()
    for p in model.parameters():
        p.requires_grad = False

    n_layers = model.config.num_hidden_layers
    n_heads = model.config.num_attention_heads
    print(f"Model has {n_layers} layers x {n_heads} heads -> "
          f"{n_layers * n_heads * 2} channels per example.")
    n_bytes = estimate_storage_bytes(len(examples), n_layers, n_heads)
    print(f"Expected feature-array size for {len(examples)} examples: "
          f"{n_bytes / 1e6:.2f} MB")

    channel_names = [
        f"L{l}_H{h}_{direction}"
        for l in range(n_layers)
        for h in range(n_heads)
        for direction in ("i2j", "j2i")
    ]

    ds = PairDataset(examples, tokenizer, max_length)
    collate_fn = make_collate_fn(tokenizer.pad_token_id)
    loader = DataLoader(ds, batch_size=batch_size, shuffle=False, collate_fn=collate_fn)

    all_feats = np.zeros((len(examples), n_layers * n_heads * 2), dtype=np.float32)
    ptr = 0
    for batch in loader:
        batch = {k: v.to(DEVICE) for k, v in batch.items()}
        out = model(
            input_ids=batch["input_ids"],
            attention_mask=batch["attention_mask"],
            output_attentions=True,
        )
        B = batch["input_ids"].size(0)
        batch_idx = torch.arange(B, device=DEVICE)
        pos1, pos2 = batch["pos1"], batch["pos2"]
        feats = []
        for layer_attn in out.attentions:  # each (B, n_heads, L, L)
            feats.append(layer_attn[batch_idx, :, pos1, pos2])  # (B, n_heads) i->j
            feats.append(layer_attn[batch_idx, :, pos2, pos1])  # (B, n_heads) j->i
        feat = torch.cat(feats, dim=-1)  # (B, n_layers*n_heads*2), i2j/j2i interleaved per layer
        all_feats[ptr:ptr + B] = feat.cpu().numpy()
        ptr += B

    return all_feats, channel_names


# ---------------------------------------------------------------------------
# 2. Save everything to a single file
# ---------------------------------------------------------------------------

def build_attention_table(
    examples: List[Example],
    association_measures: Optional[Dict[Pair, float]] = None,
    **extract_kwargs,
) -> pd.DataFrame:
    """One row per example: sentence, pair, label, optional association
    measure (looked up per pair), and every (layer, head, direction)
    attention channel."""
    feats, channel_names = extract_attention_dataset(examples, **extract_kwargs)
    df = pd.DataFrame(feats, columns=channel_names)
    df.insert(0, "word2", [ex.pair[1] for ex in examples])
    df.insert(0, "word1", [ex.pair[0] for ex in examples])
    df.insert(0, "label", [ex.label for ex in examples])
    df.insert(0, "sentence", [ex.sentence for ex in examples])
    if association_measures is not None:
        df.insert(
            4,
            "association_measure",
            [association_measures.get((r.word1, r.word2), np.nan) for r in df.itertuples()],
        )
    return df


def save_table(df: pd.DataFrame, out_path: str) -> None:
    """out_path extension picks the format: .parquet (recommended, compact
    and fast), .csv, or .npz (if you'd rather keep it in raw-array form)."""
    if out_path.endswith(".parquet"):
        df.to_parquet(out_path, index=False)
    elif out_path.endswith(".csv"):
        df.to_csv(out_path, index=False)
    elif out_path.endswith(".npz"):
        meta_cols = ["sentence", "label", "word1", "word2"]
        if "association_measure" in df.columns:
            meta_cols.append("association_measure")
        channel_cols = [c for c in df.columns if c not in meta_cols]
        np.savez_compressed(
            out_path,
            features=df[channel_cols].to_numpy(dtype=np.float32),
            channel_names=np.array(channel_cols),
            **{c: df[c].to_numpy() for c in meta_cols},
        )
    else:
        raise ValueError("out_path must end in .parquet, .csv, or .npz")
    print(f"Saved {len(df)} rows to {out_path}")


# ---------------------------------------------------------------------------
# 3. Aggregate per pair + correlate with association measures
# ---------------------------------------------------------------------------

def get_channel_columns(df: pd.DataFrame) -> List[str]:
    non_channel = {"sentence", "label", "word1", "word2", "association_measure", "pair", "n_examples"}
    return [c for c in df.columns if c not in non_channel]


def aggregate_by_pair(df: pd.DataFrame, channel_cols: Optional[Sequence[str]] = None) -> pd.DataFrame:
    """Collapse example-level attention rows into one row per (word1, word2)
    pair (mean attention per channel across that pair's examples). An
    association measure is a property of the pair, not of any one example,
    so this is the level correlations should be computed at."""
    channel_cols = list(channel_cols) if channel_cols is not None else get_channel_columns(df)
    grouped = df.groupby(["word1", "word2"])
    agg = grouped[channel_cols].mean()
    agg["n_examples"] = grouped.size()
    if "association_measure" in df.columns:
        # association measure is constant within a pair; take the first value.
        agg["association_measure"] = grouped["association_measure"].first()
    return agg.reset_index()


def correlate_with_association_measure(
    pair_level_df: pd.DataFrame,
    channel_cols: Optional[Sequence[str]] = None,
    method: str = "pearson",
    min_pairs: int = 3,
) -> pd.DataFrame:
    """Correlate each attention channel against `association_measure`
    across pairs. Returns one row per channel, sorted by |r| descending.
    `method` is 'pearson' or 'spearman'."""
    from scipy.stats import pearsonr, spearmanr

    assert "association_measure" in pair_level_df.columns, (
        "pair_level_df needs an 'association_measure' column -- pass "
        "association_measures= to build_attention_table, or merge it in "
        "yourself before calling this."
    )
    channel_cols = list(channel_cols) if channel_cols is not None else get_channel_columns(pair_level_df)
    valid = pair_level_df.dropna(subset=["association_measure"])
    if len(valid) < min_pairs:
        raise ValueError(f"Only {len(valid)} pairs have an association measure; need >= {min_pairs}.")

    corr_fn = pearsonr if method == "pearson" else spearmanr
    rows = []
    for ch in channel_cols:
        r, p = corr_fn(valid[ch], valid["association_measure"])
        rows.append({"channel": ch, "r": r, "p_value": p, "n_pairs": len(valid)})
    out = pd.DataFrame(rows)
    out = out.reindex(out["r"].abs().sort_values(ascending=False).index).reset_index(drop=True)
    return out


def correlation_heatmap_matrix(
    corr_df: pd.DataFrame, n_layers: int, n_heads: int, direction: str = "i2j"
) -> np.ndarray:
    """Reshape a channel-level correlation table back into a (n_layers,
    n_heads) grid for a given direction, handy for plt.imshow()."""
    mat = np.full((n_layers, n_heads), np.nan)
    lookup = dict(zip(corr_df["channel"], corr_df["r"]))
    for l in range(n_layers):
        for h in range(n_heads):
            mat[l, h] = lookup.get(f"L{l}_H{h}_{direction}", np.nan)
    return mat


# ---------------------------------------------------------------------------
# 4. Example usage
# ---------------------------------------------------------------------------

ASSOC_MEASURE_NAME = "pmi"
N_THRESHOLD = 20
METHOD = "pearson"
import os
os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"

if __name__ == "__main__":
    # 1. Your existing data: confident collocations / non-collocations /
    #    remaining pairs, same format as collocation_classifier.py expects.
    confident_pairs_df = pd.read_csv("../output/02_measures/exp1_selected_df_2tail.csv")

    confident_pairs_df_repel = confident_pairs_df.loc[confident_pairs_df["pmi"] < 0]
    confident_non_collocations = [(dc, sfp) for (i, (dc, sfp, n, pmi)) in confident_pairs_df_repel.iterrows()]
    confident_pairs_df_attract = confident_pairs_df.loc[confident_pairs_df["pmi"] > 0]
    confident_collocations = [(dc, sfp) for (i, (dc, sfp, n, pmi)) in confident_pairs_df_attract.iterrows()]

    with open(r"..\output\01_extract_pairs\combosDF.csv", "r", encoding="utf-8") as in_file:
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


    all_examples = (
        build_examples(confident_collocation_sentences, label=1)
        + build_examples(confident_non_collocation_sentences, label=0)
        + build_examples(non_confident_sentences, label=None)
    )

    measures_df = pd.read_csv("../output/02_measures/exp1_measures_df.csv")
    measures_df = measures_df.loc[measures_df["n"] > N_THRESHOLD]

    association_measures = dict()
    for (i, row) in measures_df.iterrows():
        if row["dc"] != row["dc"]:
            continue
        if row["sfp"] != row["sfp"]:
            continue
        sfp = row["sfp"]
        dc = row["dc"]

        dc = dc.replace("尙", "尚").replace("竝", "並").replace("眞", "真").replace("愼", "慎")
        association_measures[(dc, sfp)] = row[ASSOC_MEASURE_NAME]


    df = build_attention_table(
        all_examples,
        association_measures=association_measures,
        batch_size=16,
        max_length=128,
    )
    # save_table(df, f"../output/04_get_attention/attention_dataset.parquet")  # ~6 MB for 5299 real sentences

    pair_df = aggregate_by_pair(df)
    pair_df.to_csv(f"../output/04_get_attention/attention_dataset_aggregated.csv") 
    corr = correlate_with_association_measure(pair_df, method=METHOD)
    print(corr.head(20))
    corr.to_csv(f"../output/04_get_attention/corr_{ASSOC_MEASURE_NAME}_threshold_{N_THRESHOLD}_{METHOD}.csv")  # ~6 MB for 5299 real sentences