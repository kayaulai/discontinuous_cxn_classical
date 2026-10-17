library(tidycollo)
library(dplyr)
library(readr)
library(here)

source(here("src", "utils", "measures.R"))

combosDF = readRDS("output/01_extract_pairs/combosDF.rds")

measures = getMeasures(combosDF, c("sfp", "dc"), c("sfp", "dc"), doc_id = "docID")

measures_df = measures$results

measures_df = measures_df %>%
  mutate(p_fisher_yates_1tail = case_when(
    or > 1 ~ p_fisher_yates / 2,
    T ~ 1 - p_fisher_yates / 2))

measures_df = measures_df %>%
  mutate(p_fisher_yates_1tail_repel = case_when(
    or > 1 ~ 1 - p_fisher_yates / 2,
    T ~ p_fisher_yates / 2))


by = getBenjaminiYekutieli(measures_df$p_fisher_yates_1tail)
measures_df = measures_df %>%
  mutate(p_fisher_yates_reject = by$reject)
View(measures_df %>% filter(!is.na(sfp) & !is.na(dc)) %>% arrange(p_fisher_yates_1tail))
measures_df %>% select(sfp, dc, n, f_dc_not_sfp, f_sfp_not_dc, f_not_sfp_or_dc, or, p_fisher_yates, p_fisher_yates_1tail) %>% View
measures_df %>% filter(!is.na(sfp), !is.na(dc), p_fisher_yates_reject) %>% select(sfp, dc, n, f_dc_not_sfp, f_sfp_not_dc, f_not_sfp_or_dc, or, p_fisher_yates, p_fisher_yates_1tail, p_fisher_yates_reject) %>% View
measures_df %>% filter(!is.na(sfp), !is.na(dc), p_fisher_yates_reject, DP_norm < .99) %>% select(sfp, dc, n, f_dc_not_sfp, f_sfp_not_dc, f_not_sfp_or_dc, or, p_fisher_yates, p_fisher_yates_1tail, p_fisher_yates_reject, DP_norm, pmi) %>% arrange(pmi) %>% View

by_2tail = getBenjaminiYekutieli(measures_df$p_fisher_yates)
measures_df = measures_df %>%
  mutate(p_fisher_yates_reject_2tail = by_2tail$reject)

by_1tail_repel = getBenjaminiYekutieli(measures_df$p_fisher_yates_1tail_repel)
measures_df = measures_df %>%
  mutate(p_fisher_yates_reject_1tail_repel = by_1tail_repel$reject)


selected_df = measures_df %>% filter(!is.na(sfp), !is.na(dc), p_fisher_yates_reject, DP_norm < .99)
selected_df_2tail = measures_df %>% filter(!is.na(sfp), !is.na(dc), p_fisher_yates_reject_2tail, DP_norm < .99)
selected_df_1tail_repel = measures_df %>% filter(!is.na(sfp), !is.na(dc), p_fisher_yates_reject_1tail_repel, DP_norm < .99)

write_excel_csv(selected_df %>% select(dc, sfp, n, pmi), here("output", "02_measures", "exp1_selected_df.csv"))
write_excel_csv(selected_df_2tail %>% select(dc, sfp, n, pmi), here("output", "02_measures", "exp1_selected_df_2tail.csv"))
write_excel_csv(selected_df_1tail_repel %>% select(dc, sfp, n, pmi), here("output", "02_measures", "selected_df_1tail_repel.csv"))
write_excel_csv(measures_df, here("output", "02_measures", "exp1_measures_df.csv"))
