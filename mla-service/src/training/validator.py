"""
Model validation with A/B testing and statistical significance testing.
"""

import numpy as np
from sklearn.metrics import f1_score, roc_auc_score, precision_score, recall_score
from scipy import stats
from typing import Dict, Any, Optional
import logging

logger = logging.getLogger(__name__)


class ModelValidator:
    """
    Validate new model against current production model.
    
    Uses statistical testing to determine if improvement is significant.
    
    Example:
        >>> validator = ModelValidator()
        >>> comparison = validator.ab_test(old_model, new_model, X_test, y_test)
        >>> if comparison['decision'] == 'DEPLOY_NEW_MODEL':
        ...     deploy(new_model)
    """
    
    def __init__(
        self,
        min_improvement: float = 0.01,
        significance_level: float = 0.05
    ):
        """
        Initialize validator.
        
        Args:
            min_improvement: Minimum F1 improvement to consider (default 1%)
            significance_level: P-value threshold for statistical significance
        """
        self.min_improvement = min_improvement
        self.significance_level = significance_level
        
        logger.info(f"ModelValidator initialized")
        logger.info(f"  Minimum improvement: {min_improvement*100}%")
        logger.info(f"  Significance level: {significance_level}")
    
    def ab_test(
        self,
        model_a,  # Current production model
        model_b,  # New candidate model
        X_test: np.ndarray,
        y_test: np.ndarray
    ) -> Dict[str, Any]:
        """
        Compare two models using A/B testing methodology.
        
        Args:
            model_a: Current production model
            model_b: New candidate model
            X_test: Test features
            y_test: Test labels
        
        Returns:
            Dict with comparison results and deployment decision
        """
        logger.info("=" * 70)
        logger.info("A/B TEST: MODEL COMPARISON")
        logger.info("=" * 70)
        
        # Get predictions from both models
        logger.info("Getting predictions from Model A (current)...")
        y_pred_a = model_a.predict(X_test)
        y_prob_a = model_a.predict_proba(X_test)[:, 1]
        
        logger.info("Getting predictions from Model B (new)...")
        y_pred_b = model_b.predict(X_test)
        y_prob_b = model_b.predict_proba(X_test)[:, 1]
        
        # Calculate metrics for both models
        metrics_a = self._calculate_metrics(y_test, y_pred_a, y_prob_a)
        metrics_b = self._calculate_metrics(y_test, y_pred_b, y_prob_b)
        
        # Calculate improvements
        f1_improvement = metrics_b['f1_score'] - metrics_a['f1_score']
        auc_improvement = metrics_b['auc_roc'] - metrics_a['auc_roc']
        precision_improvement = metrics_b['precision'] - metrics_a['precision']
        recall_improvement = metrics_b['recall'] - metrics_a['recall']
        
        # Statistical significance test (McNemar's test for paired comparisons)
        p_value = self._mcnemar_test(y_test, y_pred_a, y_pred_b)
        
        # Make deployment decision
        decision, reasons = self._make_decision(
            f1_improvement=f1_improvement,
            auc_improvement=auc_improvement,
            p_value=p_value,
            metrics_a=metrics_a,
            metrics_b=metrics_b
        )
        
        result = {
            'model_a': metrics_a,
            'model_b': metrics_b,
            'improvements': {
                'f1_score': round(f1_improvement, 4),
                'auc_roc': round(auc_improvement, 4),
                'precision': round(precision_improvement, 4),
                'recall': round(recall_improvement, 4),
            },
            'p_value': round(p_value, 4),
            'is_significant': p_value < self.significance_level,
            'decision': decision,
            'reasons': reasons,
            'test_samples': len(y_test)
        }
        
        self._log_comparison(result)
        
        return result
    
    def _calculate_metrics(
        self,
        y_true: np.ndarray,
        y_pred: np.ndarray,
        y_prob: np.ndarray
    ) -> Dict[str, float]:
        """Calculate model metrics."""
        metrics = {
            'f1_score': float(f1_score(y_true, y_pred, zero_division=0)),
            'precision': float(precision_score(y_true, y_pred, zero_division=0)),
            'recall': float(recall_score(y_true, y_pred, zero_division=0)),
        }
        
        try:
            if len(np.unique(y_true)) > 1:
                metrics['auc_roc'] = float(roc_auc_score(y_true, y_prob))
            else:
                metrics['auc_roc'] = 0.5
        except Exception:
            metrics['auc_roc'] = 0.5
        
        return metrics
    
    def _mcnemar_test(
        self,
        y_true: np.ndarray,
        y_pred_a: np.ndarray,
        y_pred_b: np.ndarray
    ) -> float:
        """
        Perform McNemar's test for statistical significance.
        
        McNemar's test compares the predictive performance of two classifiers
        on paired samples.
        
        Args:
            y_true: Ground truth labels
            y_pred_a: Predictions from model A
            y_pred_b: Predictions from model B
        
        Returns:
            P-value (lower = more significant difference)
        """
        # Count disagreements
        # b: A wrong, B correct
        # c: A correct, B wrong
        correct_a = (y_pred_a == y_true)
        correct_b = (y_pred_b == y_true)
        
        b = np.sum(~correct_a & correct_b)  # A wrong, B right
        c = np.sum(correct_a & ~correct_b)  # A right, B wrong
        
        # Need at least some disagreements
        if b + c < 10:
            logger.warning("Not enough disagreements for McNemar's test")
            return 1.0  # No significant difference
        
        # McNemar's test with continuity correction
        try:
            chi2 = (abs(b - c) - 1) ** 2 / (b + c)
            p_value = 1 - stats.chi2.cdf(chi2, df=1)
            return float(p_value)
        except Exception as e:
            logger.warning(f"McNemar's test failed: {e}")
            return 1.0
    
    def _make_decision(
        self,
        f1_improvement: float,
        auc_improvement: float,
        p_value: float,
        metrics_a: Dict,
        metrics_b: Dict
    ) -> tuple:
        """
        Make deployment decision based on metrics.
        
        Returns:
            Tuple of (decision_string, list_of_reasons)
        """
        reasons = []
        
        # Check if improvement is meaningful
        if f1_improvement < self.min_improvement:
            reasons.append(
                f"F1 improvement ({f1_improvement:.4f}) below threshold ({self.min_improvement})"
            )
        else:
            reasons.append(
                f"F1 improved by {f1_improvement:.4f} (threshold: {self.min_improvement})"
            )
        
        # Check statistical significance
        if p_value >= self.significance_level:
            reasons.append(
                f"Not statistically significant (p={p_value:.4f} >= {self.significance_level})"
            )
        else:
            reasons.append(
                f"Statistically significant (p={p_value:.4f} < {self.significance_level})"
            )
        
        # Check for regressions
        if metrics_b['precision'] < metrics_a['precision'] * 0.95:
            reasons.append(
                f"Precision regression: {metrics_a['precision']:.4f} → {metrics_b['precision']:.4f}"
            )
        
        if metrics_b['recall'] < metrics_a['recall'] * 0.95:
            reasons.append(
                f"Recall regression: {metrics_a['recall']:.4f} → {metrics_b['recall']:.4f}"
            )
        
        # All gates are binding: F1 improvement alone must not ship a
        # model that is statistically indistinguishable from the
        # champion or that trades away precision/recall.
        if (f1_improvement >= self.min_improvement and
            p_value < self.significance_level and
            metrics_b['precision'] >= metrics_a['precision'] * 0.95 and
            metrics_b['recall'] >= metrics_a['recall'] * 0.95):
            decision = 'DEPLOY_NEW_MODEL'
        else:
            decision = 'KEEP_CURRENT_MODEL'

        return decision, reasons
    
    def _log_comparison(self, result: Dict):
        """Log comparison results."""
        logger.info("")
        logger.info("Model A (Current Production):")
        logger.info(f"  F1: {result['model_a']['f1_score']:.4f}")
        logger.info(f"  AUC: {result['model_a']['auc_roc']:.4f}")
        logger.info(f"  Precision: {result['model_a']['precision']:.4f}")
        logger.info(f"  Recall: {result['model_a']['recall']:.4f}")
        
        logger.info("")
        logger.info("Model B (New Candidate):")
        logger.info(f"  F1: {result['model_b']['f1_score']:.4f}")
        logger.info(f"  AUC: {result['model_b']['auc_roc']:.4f}")
        logger.info(f"  Precision: {result['model_b']['precision']:.4f}")
        logger.info(f"  Recall: {result['model_b']['recall']:.4f}")
        
        logger.info("")
        logger.info("Improvements:")
        logger.info(f"  F1: {result['improvements']['f1_score']:+.4f}")
        logger.info(f"  AUC: {result['improvements']['auc_roc']:+.4f}")
        
        logger.info("")
        logger.info(f"Statistical significance: p={result['p_value']:.4f}")
        logger.info(f"Significant: {result['is_significant']}")
        
        logger.info("")
        logger.info("Reasons:")
        for reason in result['reasons']:
            logger.info(f"  • {reason}")
        
        logger.info("")
        if result['decision'] == 'DEPLOY_NEW_MODEL':
            logger.info("🚀 DECISION: DEPLOY NEW MODEL")
        else:
            logger.info("⏸️  DECISION: KEEP CURRENT MODEL")
        
        logger.info("=" * 70)
    
    def generate_comparison_report(self, result: Dict) -> str:
        """
        Generate a formatted comparison report.
        
        Args:
            result: Comparison result dict from ab_test()
        
        Returns:
            Formatted string report
        """
        report = []
        report.append("=" * 60)
        report.append("MODEL COMPARISON REPORT")
        report.append("=" * 60)
        report.append("")
        report.append(f"Test samples: {result['test_samples']:,}")
        report.append("")
        report.append("| Metric    | Current | New     | Change  |")
        report.append("|-----------|---------|---------|---------|")
        report.append(f"| F1-score  | {result['model_a']['f1_score']:.4f}  | {result['model_b']['f1_score']:.4f}  | {result['improvements']['f1_score']:+.4f} |")
        report.append(f"| AUC-ROC   | {result['model_a']['auc_roc']:.4f}  | {result['model_b']['auc_roc']:.4f}  | {result['improvements']['auc_roc']:+.4f} |")
        report.append(f"| Precision | {result['model_a']['precision']:.4f}  | {result['model_b']['precision']:.4f}  | {result['improvements']['precision']:+.4f} |")
        report.append(f"| Recall    | {result['model_a']['recall']:.4f}  | {result['model_b']['recall']:.4f}  | {result['improvements']['recall']:+.4f} |")
        report.append("")
        report.append(f"P-value: {result['p_value']:.4f}")
        report.append(f"Statistically significant: {result['is_significant']}")
        report.append("")
        report.append(f"DECISION: {result['decision']}")
        report.append("=" * 60)
        
        return "\n".join(report)
