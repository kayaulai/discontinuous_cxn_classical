#include <TMB.hpp>

template<class Type>
Type objective_function<Type>::operator() () {
  using namespace density;

  /* -------------------- DATA -------------------- */
  DATA_VECTOR(y);           // counts
  DATA_VECTOR(offset);      // log-offset
  DATA_MATRIX(X_ref);       // reference coding design matrix
  DATA_SPARSE_MATRIX(B);           // sum-to-zero basis (blockdiag)
  DATA_SPARSE_MATRIX(C);           // mapping from sum-to-zero -> reference coding
  DATA_SCALAR(lambda);      // lasso weight

  /* ------------------ PARAMETERS ---------------- */
  PARAMETER(intercept);     // unpenalised
  PARAMETER_VECTOR(alpha);  // sum-to-zero coefficients
  PARAMETER(log_phi);       // log overdispersion

  /* ------------------ TRANSFORMS ---------------- */
  Type phi = exp(log_phi);

  // Map sum-to-zero coefficients to reference coding
  vector<Type> beta_ref = C * alpha;
  vector<Type> eta = intercept + X_ref * beta_ref + offset;
  vector<Type> mu  = exp(eta);

  /* ------------------ LIKELIHOOD ---------------- */
  Type nll = 0.0;
  for(int i=0;i<y.size();i++){
    nll -= dnbinom2(y(i), mu(i), phi, true);
  }

  /* ------------------ LASSO --------------------- */
  for(int j=0;j<alpha.size();j++){
    nll += lambda * CppAD::abs(alpha(j));
  }

  /* ------------------ REPORT ------------------- */
  REPORT(beta_ref);
  REPORT(mu);
  ADREPORT(phi);

  return nll;
}
