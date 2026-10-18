# Example sentences for the Collomap site (docs/): every corpus sentence in which a selected
# pair occurs, with the exact character positions of the two words, so the site can highlight
# them even where the lemma differs from the written character (尚 / 尙) or a collated unit
# is not written as one string (則 … 不).
#
# Inputs:  output/01_extract_pairs/combosDF.rds            (experiment 1 sentences)
#          output/03_precollation/comboListNew.rds         (experiment 2 sentences, after collation)
#          output/02_measures/exp1_selected_df.csv, output/03_precollation/exp2_selected_df.csv
#          data/raw/*.conllu                               (tokens, for positions and chapter titles)
# Outputs: output/site_examples/exp1_examples.csv, exp2_examples.csv

library(dplyr)
library(tidyr)
library(readr)
library(stringr)
library(purrr)
library(here)

selected_doc_prefix_regex = "(?:KR1h0004|KR1h0001|KR1d0052|KR2e0003)"
works = c(KR1h0004 = "論語", KR1h0001 = "孟子", KR1d0052 = "禮記", KR2e0003 = "戰國策")

# JavaScript string offsets count UTF-16 units: characters beyond U+FFFF count twice
utf16Length = function(x) vapply(x, function(s) { cp = utf8ToInt(s); length(cp) + sum(cp > 0xFFFF) }, numeric(1), USE.NAMES = FALSE)

importTokens = function(){
  bind_rows(lapply(c("test", "train", "dev"), function(s)
    udpipe::udpipe_read_conllu(here("data", "raw", paste0("lzh_kyoto-ud-", s, ".conllu"))))) %>%
    filter(str_starts(doc_id, selected_doc_prefix_regex)) %>%
    mutate(token_id = as.numeric(token_id), head_token_id = as.numeric(head_token_id)) %>%
    group_by(doc_id, paragraph_id, sentence_id) %>%
    mutate(end = cumsum(utf16Length(token)), start = end - utf16Length(token),
           root_id = token_id[head_token_id == 0][1]) %>%
    ungroup()
}

# The adverb and final-particle tokens of each sentence, picked out as in 01_extract_pairs.R
getRoleTokens = function(tokens){
  tokens %>%
    mutate(role = case_when(
      head_token_id == root_id & xpos == "p,助詞,句末,*" & token_id > root_id ~ "sfp",
      head_token_id == root_id & token_id < root_id & upos == "ADV" & !str_ends(xpos, "属格") ~ "dc",
      TRUE ~ NA_character_)) %>%
    filter(!is.na(role)) %>%
    select(sentenceID = sentence_id, role, token_id, lemma, start, end) %>%
    arrange(sentenceID, token_id)
}

# Chapter titles: each document's "_title" sentence; Analects titles drop 篇第… to match CText
getDocMeta = function(tokens){
  tokens %>%
    filter(str_ends(sentence_id, "_title")) %>%
    distinct(doc_id, title = sentence) %>%
    mutate(work = works[str_sub(doc_id, 1, 8)],
           chapter = if_else(work == "論語", str_remove(title, "篇第.*$"), title),
           source_label = paste(work, title)) %>%
    select(docID = doc_id, work, chapter, source_label)
}

# Span of `unit` among one sentence's tokens of `role`: one token whose lemma is the unit, or
# (for collated units) two tokens whose lemmas, in order, spell it; the span runs from the
# first to the last of them
findSpan = function(role_tokens, unit){
  single = which(role_tokens$lemma == unit)
  if (length(single)) return(c(role_tokens$start[single[1]], role_tokens$end[single[1]]))
  n = nrow(role_tokens)
  if (n >= 2) for (i in 1:(n - 1)) for (j in (i + 1):n) {
    if (paste0(role_tokens$lemma[i], role_tokens$lemma[j]) == unit)
      return(c(role_tokens$start[i], role_tokens$end[j]))
  }
  c(NA, NA)
}

getRowsFromCombos = function(combos){
  if (length(combos$sfp) == 0) combos$sfp = NA
  if (length(combos$dc) == 0) combos$dc = NA
  expand_grid(sfp = combos$sfp, dc = combos$dc) %>%
    mutate(docID = combos$docID, sentenceID = combos$sentenceID, sentence = combos$sentence)
}

getExamples = function(combosDF, selected, roleTokens, docMeta){
  hits = combosDF %>%
    semi_join(selected, by = c("dc", "sfp")) %>%
    distinct(dc, sfp, docID, sentenceID, sentence)
  byRole = split(roleTokens, list(roleTokens$sentenceID, roleTokens$role), drop = TRUE)
  spans = pmap(hits, function(dc, sfp, docID, sentenceID, sentence){
    c(findSpan(byRole[[paste0(sentenceID, ".dc")]], dc), findSpan(byRole[[paste0(sentenceID, ".sfp")]], sfp))
  })
  hits %>%
    mutate(w1_start = map_dbl(spans, 1), w1_end = map_dbl(spans, 2),
           w2_start = map_dbl(spans, 3), w2_end = map_dbl(spans, 4)) %>%
    left_join(docMeta, by = "docID") %>%
    transmute(word1 = dc, word2 = sfp, text = sentence, ud_sent_id = sentenceID,
              work, chapter, source_label, w1_start, w1_end, w2_start, w2_end)
}

main = function(){
  tokens = importTokens()
  sentence_text = tokens %>% group_by(sentence_id) %>% summarise(ok = paste0(token, collapse = "") == first(sentence))
  if (!all(sentence_text$ok)) warning(sum(!sentence_text$ok), " sentence(s) whose tokens do not spell the sentence; their positions may be off")
  roleTokens = getRoleTokens(tokens)
  docMeta = getDocMeta(tokens)

  combosDF_exp1 = readRDS(here("output", "01_extract_pairs", "combosDF.rds"))
  combosDF_exp2 = readRDS(here("output", "03_precollation", "comboListNew.rds")) %>%
    lapply(getRowsFromCombos) %>% bind_rows()

  dir.create(here("output", "site_examples"), showWarnings = FALSE)
  for (exp in c("exp1", "exp2")) {
    selected = read_csv(here("output", if (exp == "exp1") "02_measures" else "03_precollation",
                             paste0(exp, "_selected_df.csv")), show_col_types = FALSE)
    examples = getExamples(if (exp == "exp1") combosDF_exp1 else combosDF_exp2, selected, roleTokens, docMeta)
    write_excel_csv(examples, here("output", "site_examples", paste0(exp, "_examples.csv")), na = "")
    message(sprintf("%s: %d example sentences for %d of %d pairs; %d without exact positions",
                    exp, nrow(examples), nrow(distinct(examples, word1, word2)), nrow(selected),
                    sum(is.na(examples$w1_start) | is.na(examples$w2_start))))
  }
}

main()
