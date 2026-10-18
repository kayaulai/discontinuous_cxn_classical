# Collomap site builder

Turns an Excel table of word pairs into a finished website (no "upload your own file" features).

## One-time setup
    pip install openpyxl          # only needed to read .xlsx files

## Build a site
    python build_site.py example/example_data.xlsx --config example/site.json --out my_site

Then double-click `my_site/index.html`, or upload the whole `my_site` folder to a web host.
Add `--bundle-libs` to download the two small JavaScript libraries into the site so it does not
depend on a CDN (recommended for the live version).

## What goes where
- `example/example_data.xlsx`  : a sheet "pairs" and a sheet "examples" (copy its layout).
- `example/site.json`          : your settings: site name, dataset title, authors, group names
                                 ("Adverb" / "Final particle"), default view, citation details,
                                 and which of YOUR column headings mean what.
- Command-line shortcuts: `--first-name`, `--second-name`, `--title`, `--site-name`,
  `--examples other_file.xlsx` (if the sentences are in a separate file).
- `python build_site.py --help` lists everything.

## Two one-way scores (optional)

A pairs sheet can carry `sym_score` (mutual strength) and up to two one-way scores:
`asym_score` is the pull of the **first** word on the second, and `asym_score_2` the pull of the
**second** word on the first. When a word is in focus the picture uses the score for that direction
(click an adverb: first-to-second; click a particle: second-to-first). If `asym_score_2` is missing,
`asym_score` is used for both.

## Experiment 1 data (adverbs and final particles)

`convert_exp1.py` turns the measures file plus the list of selected pairs into the Excel file and
settings file for the builder. Its settings block (slot names, which measure is which) is at the top.

    python convert_exp1.py exp1_measures_df.csv exp1_selected_df.csv --out-dir exp1
    python build_site.py exp1/exp1_site_data.xlsx --config exp1/exp1_site.json --out exp1/site

## Experiment 2 data (pre-collated adverbs and final particles)

`convert_exp2.py` does the same for experiment 2. Its selected file already holds the measures
(PMI and both KLDs), so it takes only that one file. Some adverbs and particles are merged
two-character units (e.g. 豈不, 而已). The headings match experiment 1, so `add_tags.py` works too.

    python convert_exp2.py exp2_selected_df.csv --out-dir exp2
    python add_tags.py exp2/exp2_site_data.xlsx exp2_selected_df_tagged.csv
    python build_site.py exp2/exp2_site_data.xlsx --config exp2/exp2_site.json --out exp2/site

## Appearance settings (in the same JSON file)
    "font_family":       "Helvetica, Arial, sans-serif",        interface font
    "word_font_family":  "'Noto Sans CJK TC', 'PingFang TC', 'Microsoft JhengHei', sans-serif",
                                                                  font for the words / sentences / graph labels
    "word_line_height":  1.8,                                    line spacing of sentences (Tibetan: 2.2 or more)
    "font_size":         15,                                     base size in px (12-24)
    "font_files":        ["fonts/NotoSansTibetan.ttf"],          ships your own font with the site (paths are
                                                                  relative to the settings file; .woff2/.woff/.ttf/.otf)
    "colors":  {"first": "#1a64a8", "second": "#b4500a", "accent": "#1a64a8"}
    "lang":    "en"                                              language code of the page ("bo", "zh-Hant", ...)

Tibetan example: put `NotoSansTibetan.ttf` in a `fonts/` folder next to your settings file, then use
`"font_files": ["fonts/NotoSansTibetan.ttf"]`, `"word_font_family": "'Noto Sans Tibetan', sans-serif"`,
`"word_line_height": 2.3`. A font listed in `font_files` is added to the word font automatically.
Use plain-ASCII family names (e.g. "Noto Sans CJK TC") so the graph labels can use them too.
The builder warns if a colour is too pale to read against white.

## Updating the live site
Edit the Excel file, run the same command again, re-upload the folder.

## The site in this repo (`docs/`)
`docs/` holds both experiments, published from that folder with GitHub Pages. `docs/index.html` is
a hand-written page linking to the two. The example sentences come from `src/site_examples.R`
(run it from the repo root after steps 01–03; it writes `output/site_examples/`). To rebuild the
sites, run this from this folder:

    python convert_exp1.py ../../output/02_measures/exp1_measures_df.csv ../../output/02_measures/exp1_selected_df.csv --out-dir exp1
    python add_tags.py exp1/exp1_site_data.xlsx ../../output/02_measures/exp1_selected_df_tagged.csv
    python build_site.py exp1/exp1_site_data_tagged.csv --examples ../../output/site_examples/exp1_examples.csv --config exp1/site_settings.json --out ../../docs/exp1 --bundle-libs

    python convert_exp2.py ../../output/03_precollation/exp2_selected_df.csv --out-dir exp2
    python add_tags.py exp2/exp2_site_data.xlsx ../../output/03_precollation/exp2_selected_df_tagged.csv
    python build_site.py exp2/exp2_site_data_tagged.csv --examples ../../output/site_examples/exp2_examples.csv --config exp2/site_settings.json --out ../../docs/exp2 --bundle-libs

The site's settings (title, about text, group names, default distance, colours, ...) live in
`exp1/site_settings.json` and `exp2/site_settings.json`. Edit those by hand and rebuild. The
`*_site.json` files the converters write are not used for `docs/`, since the tagged CSV already
has the standard column names. `default_distance` is `"one-way"` or `"mutual"`.

## Optional check
    pip install playwright && playwright install chromium
    python test_built_site.py my_site/index.html     # written for the bundled example data

`template/` holds the site's HTML/CSS/JS; you normally never need to touch it. Opened directly, the
template is a general "open your own file" site. `build_site.py` cuts every block marked
`byod-start` / `byod-end` (file opening, drag and drop, example data, file templates and their help)
out of the built page, so a built site only ever shows its own data.
