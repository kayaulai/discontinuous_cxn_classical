getBenjaminiYekutieli = function(pval, alpha = .05){
  pval_arr = sort(pval)

  m = length(pval_arr)
  cm = sum(1 / seq_len(m))

  o = order(pval)
  pval_sorted = pval[o]
  cv_sorted = seq_len(m) / (m * cm) * alpha

  cv = numeric(m)
  cv[o] = cv_sorted

  reject_sorted = rep(FALSE, m)
  below_threshold = which(pval_sorted <= cv_sorted)
  if (length(below_threshold) > 0) {
    max_i = max(below_threshold)
    reject_sorted[1:max_i] = TRUE
  }
  reject = logical(m)
  reject[o] = reject_sorted

  MFDR = alpha * (m + 1) /  (2 * m * (log(m) + -digamma(1))+ 1)

  result = list(cv = cv, reject = reject, MFDR = MFDR)
  result
}
