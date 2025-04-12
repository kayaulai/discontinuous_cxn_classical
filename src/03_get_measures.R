measures = getMeasures(combosDF, c("sfp", "dc"), c("sfp", "dc"), doc_id = "docID")

measures_df = measures$results

measures_df = measures_df %>%
  mutate(p_fisher_yates_1tail = case_when(
    or > 1 ~ p_fisher_yates / 2,
    T ~ 1 - p_fisher_yates / 2))

by = getBenjaminiYekutieli(measures_df$p_fisher_yates_1tail)
measures_df = measures_df %>%
  mutate(p_fisher_yates_reject = by$reject)
View(measures_df %>% filter(!is.na(sfp) & !is.na(dc)) %>% arrange(p_fisher_yates_1tail))
measures_df %>% select(sfp, dc, n, f_dc_not_sfp, f_sfp_not_dc, f_not_sfp_or_dc, or, p_fisher_yates, p_fisher_yates_1tail) %>% View
measures_df %>% filter(!is.na(sfp), !is.na(dc), p_fisher_yates_reject) %>% select(sfp, dc, n, f_dc_not_sfp, f_sfp_not_dc, f_not_sfp_or_dc, or, p_fisher_yates, p_fisher_yates_1tail, p_fisher_yates_reject) %>% View
measures_df %>% filter(!is.na(sfp), !is.na(dc), p_fisher_yates_reject, DP_norm < .99) %>% select(sfp, dc, n, f_dc_not_sfp, f_sfp_not_dc, f_not_sfp_or_dc, or, p_fisher_yates, p_fisher_yates_1tail, p_fisher_yates_reject, DP_norm, pmi) %>% arrange(pmi) %>% View
  
selected_df = measures_df %>% filter(!is.na(sfp), !is.na(dc), p_fisher_yates_reject, DP_norm < .99)

write_excel_csv(selected_df %>% select(dc, sfp, n, pmi), here("output", "selected_df.csv"))
