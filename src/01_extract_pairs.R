library(tidyverse)
library(tidyr)
library(here)

library(tidycollo)
library(glue)
library(udpipe)
library(data.tree)

source(here("src", "utils", "trees.R"))

importData = function(selected_doc_prefix_regex){
  conllu_test = udpipe::udpipe_read_conllu(here("data", "raw", "lzh_kyoto-ud-test.conllu")) %>%
    mutate(set = "test")
  conllu_train = udpipe::udpipe_read_conllu(here("data", "raw", "lzh_kyoto-ud-train.conllu")) %>%
    mutate(set = "train")
  conllu_dev = udpipe::udpipe_read_conllu(here("data", "raw", "lzh_kyoto-ud-dev.conllu")) %>%
    mutate(set = "dev")

  conllu_all = bind_rows(conllu_test, conllu_train, conllu_dev) %>%
    filter(str_starts(doc_id, selected_doc_prefix_regex))
}

getConlluSents = function(conllu_all){
  conllu_all %>%
    group_by(doc_id, paragraph_id, sentence_id, sentence) %>%
    group_split
}

viewSentIDs = function(conllu_sents) conllu_sents %>% sapply(function(x) x$sentence_id[1])

getCombos = function(root, conllu_sent){
  print(glue("Processing: {conllu_sent$doc_id[1]} -  {conllu_sent$paragraph_id[1]} - {conllu_sent$sentence[1]}"))
  root_kids = as.numeric(names(root$children))
  rootID = as.numeric(root$name)
  sfp = conllu_sent %>%
    filter(.data$head_token_id == rootID,
            .data$xpos == "p,助詞,句末,*",
            .data$token_id > rootID
            ) %>% pull(lemma)
  adv_conj = conllu_sent %>%
    filter(
      .data$head_token_id == rootID,
      .data$token_id < rootID,
      .data$upos %in% c("ADV"),
      !str_ends(.data$xpos, "属格") #exclude 之
      ) %>% pull(lemma)

  list(sfp = sfp, dc = adv_conj, root = root$lemma)
}

getComboList = function(conllu_sents){
  lapply(conllu_sents, function(conllu_sent){
    conllu_sent_wtree = getTreeFromConllu(conllu_sent)
    combos = getCombos(conllu_sent_wtree$root, conllu_sent_wtree$df)
    c(list(docID = conllu_sent$doc_id[1],
            paragraphID = conllu_sent$paragraph_id[1],
            sentenceID = conllu_sent$sentence_id[1],
            sentence = conllu_sent$sentence[1],
            set = conllu_sent$set[1]
          ), combos)
  })
}

getRowsFromCombos = function(combos){
  n_sfp = length(combos$sfp)
  n_dc = length(combos$dc)
  if(n_sfp == 0) combos$sfp = NA
  if(n_dc == 0) combos$dc = NA
  expand_grid(sfp = combos$sfp, dc = combos$dc) %>%
    mutate(docID = combos$docID,
           paragraphID = combos$paragraphID,
           sentenceID = combos$sentenceID,
           sentence = combos$sentence,
           root = combos$root)
}


main = function(){
  selected_doc_prefix_regex = "(?:KR1h0004|KR1h0001|KR1d0052|KR2e0003)"
  conllu_all = importData(selected_doc_prefix_regex)
  conllu_sents = getConlluSents(conllu_all)
  comboList = getComboList(conllu_sents)
  combosDF = lapply(comboList, getRowsFromCombos) %>% bind_rows
  write_rds(comboList, here("output", "01_extract_pairs", "comboList.rds"))
  write_rds(combosDF, here("output", "01_extract_pairs", "combosDF.rds"))
  write_csv(combosDF, here("output", "01_extract_pairs", "combosDF.csv"))
}


if(interactive()){
  main()
}