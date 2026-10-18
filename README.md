# Code and data for 'Mapping the particle frames of Ancient Chinese: Statistical extraction and semantic analysis of an elusive discontinuous construction' 

Code and outputs for a study of particle frames in Classical Chinese: pairs of a pre-verbal **adverb** (`dc` in the code) and a sentence-final **particle** (`sfp`) that depend on the same root, as in 豈 … 哉 or 必 … 矣. The analyses are:

- **Experiment 1**: association measures between adverbs and final particles.
- **Experiment 2**: the same, after first merging adverb–adverb and particle–particle collocations into single units (pre-collation).
- **Experiment 3** (BERT attention): whether a Classical Chinese BERT's attention between the two members of a pair tracks those association measures.
- **Appendix**: an alternative, subtree-based method.

## Data

`data/raw/` holds the [UD Classical Chinese Kyoto treebank](https://github.com/UniversalDependencies/UD_Classical_Chinese-Kyoto) (train, dev and test `.conllu` files). All three splits are pooled, and only four texts are used:

| ID | Text |
|---|---|
| KR1h0004 | 論語 *Analects* |
| KR1h0001 | 孟子 *Mencius* |
| KR1d0052 | 禮記 *Book of Rites* |
| KR2e0003 | 戰國策 *Strategies of the Warring States* |

## Pipeline

Each script in `src/` writes to the folder of the same name in `output/`.

| Step | Script | What it does | Main outputs |
|---|---|---|---|
| 01 | `01_extract_pairs.R` | Finds each sentence's root and collects the adverbs before it and the final particles after it that depend on it | `comboList.rds`; `combosDF.rds` / `.csv` (one row per adverb × particle per sentence) |
| 02 | `02_get_measures.R` | **Experiment 1.** Computes association and dispersion measures with `tidycollo`, then selects pairs by a one-tailed Fisher–Yates test (Benjamini–Yekutieli corrected) and `DP_norm < .99` | `exp1_measures_df.csv` (all pairs, all measures); `exp1_selected_df.csv` (selected pairs); two-tailed and repulsion variants |
| 03 | `03_precollation.Rmd` | **Experiment 2.** Finds adverb–adverb and particle–particle collocations (e.g. 豈不, 而已), merges them into single units, then reruns the Experiment 1 selection | `exp2_collated_dc.csv`, `exp2_collated_sfp.csv`, `exp2_selected_df.csv`, `exp1_exp2_comparison.csv` |
| 04 | `04_get_attention.py` | Extracts the attention weights of [`jihuai/bert-ancient-chinese`](https://huggingface.co/jihuai/bert-ancient-chinese) between the adverb and the particle (every layer and head, both directions) for each sentence. Averages them per pair and correlates each layer/head with an association measure | `attention_dataset*.parquet` / `.csv`; `corr_<measure>_threshold_<N>_<method>.csv` |
| 05 | `05_analyse_attention.qmd` | **Experiment 3.** Draws the correlation heatmaps, regresses each measure on its 10 most correlated attention heads, and uses the fit to flag new candidate pairs | `heatmaps/*.png`, `detected_pairs_<measure>.csv` |
| — | `appendix_subtree.Rmd` | **Appendix.** Subtree-based alternative: first merges adverbs with the root verbs they are attracted to, then tests the merged units against final particles, at α = .05, .1 and .2 | `final_pairs_<alpha>.csv`, `subtree_exp1_comparison_<alpha>.csv` |
| — | `site_examples.R` | Collects the website's example sentences: every sentence containing a selected Experiment 1 or 2 pair, with the positions of the two words | `exp1_examples.csv`, `exp2_examples.csv` (in `output/site_examples/`) |

Helper functions are in `src/utils/`: `trees.R` (dependency trees from CoNLL-U), `measures.R` (the Benjamini–Yekutieli procedure) and `data_classes.py` (example and dataset classes for step 04).

### Hand-annotated files

The `*_tagged.csv` files (`output/02_measures/exp1_selected_df_tagged.csv` and `output/03_precollation/exp2_selected_df_tagged.csv`) contain manual semantic categories (`cat`, `cat_long`, `full`).

## Setup

**R** (4.5). Dependencies are pinned with [renv](https://rstudio.github.io/renv/). Open `discontinuous_cxn_classical.Rproj`, or start R in the repo root, then run:

```r
renv::restore()
```

This includes [`tidycollo`](https://github.com/kayaulai/tidycollo), installed from GitHub, which computes all the association and dispersion measures.

**Python** (for step 04):

```sh
pip install -r requirements.txt
```

The model is downloaded from Hugging Face on first use. A GPU is used if available but is not required.

## Running

The R steps assume the **repo root** as the working directory (paths are built with `here()`).

```r
# 01: main() only runs automatically in an interactive session
source("src/01_extract_pairs.R"); main()

# 02: written to be run interactively (it opens View() windows)
source("src/02_get_measures.R")
```

Run `03_precollation.Rmd` and `appendix_subtree.Rmd` chunk by chunk in RStudio, or knit them. Both rerun `tidycollo`'s dispersion measures several times and take a few minutes.

Step 04 is run **from inside `src/`**, because its paths are relative to that folder (and one of them uses Windows separators):

```sh
cd src
python 04_get_attention.py
```

The settings at the top of the main block pick the association measure to correlate against: `ASSOC_MEASURE_NAME` (`pmi`, `kld_norm_dc_cond_sfp` or `kld_norm_sfp_cond_dc`), `N_THRESHOLD` (minimum pair frequency) and `METHOD` (`pearson` or `spearman`). Run it once per combination. The line that saves the per-sentence `attention_dataset.parquet` (about 6 MB) is commented out; uncomment it to regenerate that file.

Step 05 reads the parquet and every `corr_*.csv` in `output/04_get_attention/`. Its paths are also relative to the repo root, so run it interactively from there, or render with:

```sh
quarto render src/05_analyse_attention.qmd --execute-dir .
```

## Other folders

- `docs/` is the built website for browsing the Experiment 1 and Experiment 2 pairs (`docs/exp1/`, `docs/exp2/`), ready for GitHub Pages (serve from the `docs/` folder).
- `site/collomap_builder/` builds that website; its README says how to rebuild it.
- `src/retired/` and `output/retired/` hold old, half completed files that might not actually run properly any more.
