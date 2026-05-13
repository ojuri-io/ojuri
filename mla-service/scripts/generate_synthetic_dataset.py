#!/usr/bin/env python3
"""
Generate Synthetic Fraud Detection Dataset.

Creates a realistic synthetic dataset for training when real datasets
(IEEE-CIS, PaySim) are not available.

The synthetic data models:
1. Mobile money transaction patterns (CASH_IN, CASH_OUT, DEBIT, PAYMENT, TRANSFER)
2. Temporal patterns (business hours, weekends, night transactions)
3. Amount distributions (log-normal, typical fraud amounts)
4. Realistic fraud rate (~3.5% to match IEEE-CIS)

Usage:
    python scripts/generate_synthetic_dataset.py
    python scripts/generate_synthetic_dataset.py --samples 100000
    python scripts/generate_synthetic_dataset.py --fraud-rate 0.035
"""

import argparse
import os
import sys
import numpy as np
import pandas as pd
from pathlib import Path
import logging

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Output directory
DATA_DIR = Path(__file__).parent.parent / 'data' / 'synthetic'


def generate_synthetic_dataset(
    n_samples: int = 50000,
    fraud_rate: float = 0.035,
    seed: int = 42
) -> pd.DataFrame:
    """
    Generate synthetic fraud detection dataset.
    
    Models IEEE-CIS and PaySim characteristics:
    - 434 features
    - Realistic fraud patterns
    - Mobile money transaction types
    - Temporal and behavioral features
    
    Args:
        n_samples: Number of transactions to generate
        fraud_rate: Target fraud rate (default 3.5% like IEEE-CIS)
        seed: Random seed for reproducibility
    
    Returns:
        DataFrame with transactions and features
    """
    logger.info("=" * 70)
    logger.info("GENERATING SYNTHETIC FRAUD DATASET")
    logger.info("=" * 70)
    logger.info(f"Samples: {n_samples:,}")
    logger.info(f"Target fraud rate: {fraud_rate * 100:.1f}%")
    logger.info("")
    
    np.random.seed(seed)
    
    # Transaction types and their fraud propensities
    tx_types = ['TRANSFER', 'CASH_OUT', 'PAYMENT', 'CASH_IN', 'DEBIT']
    tx_probs = [0.35, 0.25, 0.20, 0.15, 0.05]
    
    # Higher fraud probability for TRANSFER and CASH_OUT
    fraud_multipliers = {
        'TRANSFER': 2.0,
        'CASH_OUT': 1.8,
        'PAYMENT': 0.5,
        'CASH_IN': 0.3,
        'DEBIT': 0.4
    }
    
    data = {}
    
    # ═══════════════════════════════════════════════════════════════
    # BASIC TRANSACTION ATTRIBUTES
    # ═══════════════════════════════════════════════════════════════
    
    logger.info("Generating transaction attributes...")
    
    # Transaction IDs
    data['TransactionID'] = [f'TXN{i:010d}' for i in range(n_samples)]
    
    # Transaction types
    data['type'] = np.random.choice(tx_types, n_samples, p=tx_probs)
    
    # Amounts (log-normal distribution, typical for financial transactions)
    base_amounts = np.random.lognormal(mean=7, sigma=2, size=n_samples)
    data['TransactionAmt'] = np.clip(base_amounts, 1, 1000000).astype(np.float32)
    
    # ═══════════════════════════════════════════════════════════════
    # TEMPORAL FEATURES
    # ═══════════════════════════════════════════════════════════════
    
    logger.info("Generating temporal features...")
    
    # Time simulation (hours 0-23)
    data['hour'] = np.random.randint(0, 24, n_samples)
    data['day_of_week'] = np.random.randint(0, 7, n_samples)
    data['day_of_month'] = np.random.randint(1, 29, n_samples)
    
    # Derived temporal features
    data['is_weekend'] = (data['day_of_week'] >= 5).astype(int)
    data['is_night'] = ((data['hour'] >= 22) | (data['hour'] < 6)).astype(int)
    data['is_business_hours'] = ((data['hour'] >= 9) & (data['hour'] < 17)).astype(int)
    
    # ═══════════════════════════════════════════════════════════════
    # ACCOUNT FEATURES
    # ═══════════════════════════════════════════════════════════════
    
    logger.info("Generating account features...")
    
    # Balance features
    data['oldbalanceOrg'] = np.random.lognormal(mean=9, sigma=2, size=n_samples).astype(np.float32)
    data['newbalanceOrig'] = (data['oldbalanceOrg'] - data['TransactionAmt']).clip(0).astype(np.float32)
    data['oldbalanceDest'] = np.random.lognormal(mean=9, sigma=2, size=n_samples).astype(np.float32)
    data['newbalanceDest'] = (data['oldbalanceDest'] + data['TransactionAmt']).astype(np.float32)
    
    # Balance ratios
    data['balance_change_orig'] = (data['newbalanceOrig'] - data['oldbalanceOrg']).astype(np.float32)
    data['amount_to_balance_ratio'] = np.where(
        data['oldbalanceOrg'] > 0,
        data['TransactionAmt'] / data['oldbalanceOrg'],
        0
    ).astype(np.float32)
    
    # Full withdrawal indicator
    data['is_full_withdrawal'] = (
        (data['oldbalanceOrg'] > 0) & 
        (data['newbalanceOrig'] == 0)
    ).astype(int)
    
    # ═══════════════════════════════════════════════════════════════
    # DEVICE AND IDENTITY FEATURES (V-series mimicking IEEE-CIS)
    # ═══════════════════════════════════════════════════════════════
    
    logger.info("Generating device and behavioral features...")
    
    # Card features (C1-C14)
    for i in range(1, 15):
        if i <= 6:
            data[f'C{i}'] = np.random.randint(0, 100, n_samples).astype(np.float32)
        else:
            data[f'C{i}'] = np.random.random(n_samples).astype(np.float32)
    
    # Device info (D1-D15)
    for i in range(1, 16):
        data[f'D{i}'] = np.random.random(n_samples).astype(np.float32) * 100
    
    # V-series features (V1-V339) - behavioral aggregations
    # These are the main features in IEEE-CIS
    n_v_features = 339
    logger.info(f"  Generating {n_v_features} V-series behavioral features...")
    
    for i in range(1, n_v_features + 1):
        if i <= 50:
            # Count-based features
            data[f'V{i}'] = np.random.poisson(lam=5, size=n_samples).astype(np.float32)
        elif i <= 150:
            # Ratio features
            data[f'V{i}'] = np.random.beta(a=2, b=5, size=n_samples).astype(np.float32)
        elif i <= 250:
            # Amount-based features
            data[f'V{i}'] = np.random.lognormal(mean=3, sigma=1, size=n_samples).astype(np.float32)
        else:
            # Binary/categorical features
            data[f'V{i}'] = np.random.binomial(n=1, p=0.3, size=n_samples).astype(np.float32)
    
    # ═══════════════════════════════════════════════════════════════
    # FRAUD LABEL GENERATION
    # ═══════════════════════════════════════════════════════════════
    
    logger.info("Generating fraud labels with realistic patterns...")
    
    # Base fraud probability
    fraud_probs = np.ones(n_samples) * fraud_rate
    
    # Adjust based on transaction type
    for tx_type, mult in fraud_multipliers.items():
        mask = data['type'] == tx_type
        fraud_probs[mask] *= mult
    
    # Higher fraud for large amounts
    high_amount_mask = data['TransactionAmt'] > 50000
    fraud_probs[high_amount_mask] *= 1.5
    
    # Higher fraud at night
    night_mask = data['is_night'] == 1
    fraud_probs[night_mask] *= 1.3
    
    # Higher fraud for full withdrawals
    withdrawal_mask = data['is_full_withdrawal'] == 1
    fraud_probs[withdrawal_mask] *= 2.0
    
    # Normalize to maintain target fraud rate
    current_expected_rate = fraud_probs.mean()
    fraud_probs = fraud_probs * (fraud_rate / current_expected_rate)
    fraud_probs = np.clip(fraud_probs, 0, 0.8)
    
    # Generate fraud labels
    data['isFraud'] = (np.random.random(n_samples) < fraud_probs).astype(int)
    
    # ═══════════════════════════════════════════════════════════════
    # CREATE DATAFRAME
    # ═══════════════════════════════════════════════════════════════
    
    df = pd.DataFrame(data)
    
    # Reorder columns: ID, target, features
    cols = ['TransactionID', 'isFraud', 'type', 'TransactionAmt'] + \
           [c for c in df.columns if c not in ['TransactionID', 'isFraud', 'type', 'TransactionAmt']]
    df = df[cols]
    
    # Statistics
    actual_fraud_rate = df['isFraud'].mean()
    fraud_count = df['isFraud'].sum()
    
    logger.info("")
    logger.info("=" * 70)
    logger.info("DATASET GENERATION COMPLETE")
    logger.info("=" * 70)
    logger.info(f"Total samples: {len(df):,}")
    logger.info(f"Features: {len(df.columns) - 2}")  # Exclude ID and target
    logger.info(f"Fraud samples: {fraud_count:,}")
    logger.info(f"Legitimate samples: {len(df) - fraud_count:,}")
    logger.info(f"Actual fraud rate: {actual_fraud_rate * 100:.2f}%")
    logger.info("")
    
    # Transaction type breakdown
    logger.info("Fraud by transaction type:")
    for tx_type in tx_types:
        type_df = df[df['type'] == tx_type]
        type_fraud_rate = type_df['isFraud'].mean() * 100
        logger.info(f"  {tx_type}: {len(type_df):,} transactions, {type_fraud_rate:.2f}% fraud")
    
    return df


def save_dataset(df: pd.DataFrame, output_path: Path) -> str:
    """
    Save dataset to CSV.
    
    Args:
        df: DataFrame to save
        output_path: Output file path
    
    Returns:
        Path to saved file
    """
    output_path.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(output_path, index=False)
    
    size_mb = output_path.stat().st_size / (1024 * 1024)
    logger.info(f"Dataset saved to: {output_path}")
    logger.info(f"File size: {size_mb:.1f} MB")
    
    return str(output_path)


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description='Generate synthetic fraud detection dataset'
    )
    parser.add_argument(
        '--samples', '-n',
        type=int,
        default=50000,
        help='Number of samples to generate (default: 50000)'
    )
    parser.add_argument(
        '--fraud-rate', '-f',
        type=float,
        default=0.035,
        help='Target fraud rate (default: 0.035 = 3.5%%)'
    )
    parser.add_argument(
        '--output', '-o',
        type=str,
        default=None,
        help='Output file path (default: data/synthetic/train_synthetic.csv)'
    )
    parser.add_argument(
        '--seed', '-s',
        type=int,
        default=42,
        help='Random seed (default: 42)'
    )
    
    args = parser.parse_args()
    
    # Generate dataset
    df = generate_synthetic_dataset(
        n_samples=args.samples,
        fraud_rate=args.fraud_rate,
        seed=args.seed
    )
    
    # Save dataset
    if args.output:
        output_path = Path(args.output)
    else:
        output_path = DATA_DIR / 'train_synthetic.csv'
    
    save_dataset(df, output_path)
    
    logger.info("")
    logger.info("Next steps:")
    logger.info("  1. Run training with synthetic data:")
    logger.info("     python scripts/train_with_datasets.py --synthetic")
    logger.info("  2. Or load in Python:")
    logger.info("     df = pd.read_csv('data/synthetic/train_synthetic.csv')")


if __name__ == '__main__':
    main()
