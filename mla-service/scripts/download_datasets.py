#!/usr/bin/env python3
"""
Dataset Download Script for Fraud Detection Training.

Downloads and prepares:
1. IEEE-CIS Fraud Detection dataset (Kaggle competition)
2. PaySim synthetic mobile money dataset

Prerequisites:
    pip install kaggle
    
    Then configure Kaggle API:
    1. Go to kaggle.com -> Account -> Create New API Token
    2. Place kaggle.json in ~/.kaggle/kaggle.json
    3. chmod 600 ~/.kaggle/kaggle.json

Usage:
    python scripts/download_datasets.py
    python scripts/download_datasets.py --ieee-only
    python scripts/download_datasets.py --paysim-only
"""

import os
import sys
import argparse
import zipfile
import logging
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Data directory
DATA_DIR = Path(__file__).parent.parent / 'data'


def check_kaggle_api():
    """Check if Kaggle API is configured."""
    kaggle_json = Path.home() / '.kaggle' / 'kaggle.json'
    
    if not kaggle_json.exists():
        logger.error("=" * 70)
        logger.error("Kaggle API not configured!")
        logger.error("")
        logger.error("To download datasets, you need to configure Kaggle API:")
        logger.error("")
        logger.error("1. Go to https://www.kaggle.com/account")
        logger.error("2. Scroll to 'API' section and click 'Create New Token'")
        logger.error("3. This downloads kaggle.json")
        logger.error("4. Move it to ~/.kaggle/kaggle.json")
        logger.error("5. Run: chmod 600 ~/.kaggle/kaggle.json")
        logger.error("")
        logger.error("Alternatively, manually download datasets from:")
        logger.error("- IEEE-CIS: https://www.kaggle.com/c/ieee-fraud-detection/data")
        logger.error("- PaySim: https://www.kaggle.com/datasets/ealaxi/paysim1")
        logger.error("")
        logger.error("Place CSV files in: " + str(DATA_DIR))
        logger.error("=" * 70)
        return False
    
    return True


def download_ieee_cis():
    """
    Download IEEE-CIS Fraud Detection dataset.
    
    Dataset info:
    - Source: Kaggle competition ieee-fraud-detection
    - Size: ~1.5 GB compressed
    - Files: train_transaction.csv, train_identity.csv, test files
    - Samples: 590,540 transactions
    - Features: 434 engineered features
    - Fraud rate: ~3.5%
    """
    logger.info("=" * 70)
    logger.info("Downloading IEEE-CIS Fraud Detection Dataset")
    logger.info("=" * 70)
    logger.info("Source: Kaggle competition 'ieee-fraud-detection'")
    logger.info("Paper: IEEE Computational Intelligence Society, 2019")
    logger.info("")
    
    ieee_dir = DATA_DIR / 'ieee-cis'
    ieee_dir.mkdir(parents=True, exist_ok=True)
    
    # Check if already downloaded
    if (ieee_dir / 'train_transaction.csv').exists():
        logger.info("✓ IEEE-CIS dataset already exists")
        return True
    
    try:
        from kaggle.api.kaggle_api_extended import KaggleApi
        
        api = KaggleApi()
        api.authenticate()
        
        logger.info("Downloading from Kaggle (this may take several minutes)...")
        logger.info("Dataset size: ~1.5 GB")
        
        # Download competition files
        api.competition_download_files(
            'ieee-fraud-detection',
            path=str(ieee_dir)
        )
        
        # Extract zip file
        zip_path = ieee_dir / 'ieee-fraud-detection.zip'
        if zip_path.exists():
            logger.info("Extracting files...")
            with zipfile.ZipFile(zip_path, 'r') as zip_ref:
                zip_ref.extractall(ieee_dir)
            zip_path.unlink()  # Remove zip after extraction
        
        logger.info("✓ IEEE-CIS dataset downloaded successfully")
        return True
        
    except ImportError:
        logger.error("Kaggle package not installed. Run: pip install kaggle")
        return False
    except Exception as e:
        logger.error(f"Failed to download IEEE-CIS dataset: {e}")
        logger.info("")
        logger.info("Manual download instructions:")
        logger.info("1. Go to: https://www.kaggle.com/c/ieee-fraud-detection/data")
        logger.info("2. Download train_transaction.csv and train_identity.csv")
        logger.info(f"3. Place files in: {ieee_dir}")
        return False


def download_paysim():
    """
    Download PaySim synthetic mobile money dataset.
    
    Dataset info:
    - Source: Kaggle dataset 'ealaxi/paysim1'
    - Paper: Lopez-Rojas et al., 2016
    - Size: ~500 MB
    - Samples: 6,362,620 transactions (we'll use 50,000 subset)
    - Transaction types: CASH_IN, CASH_OUT, DEBIT, PAYMENT, TRANSFER
    - Fraud rate: ~0.13%
    """
    logger.info("=" * 70)
    logger.info("Downloading PaySim Mobile Money Dataset")
    logger.info("=" * 70)
    logger.info("Source: Kaggle dataset 'ealaxi/paysim1'")
    logger.info("Paper: Lopez-Rojas et al., 2016")
    logger.info("")
    
    paysim_dir = DATA_DIR / 'paysim'
    paysim_dir.mkdir(parents=True, exist_ok=True)
    
    # Check if already downloaded
    if (paysim_dir / 'PS_20174392719_1491204439457_log.csv').exists():
        logger.info("✓ PaySim dataset already exists")
        return True
    
    try:
        from kaggle.api.kaggle_api_extended import KaggleApi
        
        api = KaggleApi()
        api.authenticate()
        
        logger.info("Downloading from Kaggle...")
        logger.info("Dataset size: ~500 MB")
        
        # Download dataset
        api.dataset_download_files(
            'ealaxi/paysim1',
            path=str(paysim_dir)
        )
        
        # Extract zip file
        zip_path = paysim_dir / 'paysim1.zip'
        if zip_path.exists():
            logger.info("Extracting files...")
            with zipfile.ZipFile(zip_path, 'r') as zip_ref:
                zip_ref.extractall(paysim_dir)
            zip_path.unlink()  # Remove zip after extraction
        
        logger.info("✓ PaySim dataset downloaded successfully")
        return True
        
    except ImportError:
        logger.error("Kaggle package not installed. Run: pip install kaggle")
        return False
    except Exception as e:
        logger.error(f"Failed to download PaySim dataset: {e}")
        logger.info("")
        logger.info("Manual download instructions:")
        logger.info("1. Go to: https://www.kaggle.com/datasets/ealaxi/paysim1")
        logger.info("2. Download the dataset")
        logger.info(f"3. Place PS_20174392719_1491204439457_log.csv in: {paysim_dir}")
        return False


def verify_datasets():
    """Verify downloaded datasets."""
    logger.info("")
    logger.info("=" * 70)
    logger.info("Verifying Downloaded Datasets")
    logger.info("=" * 70)
    
    ieee_dir = DATA_DIR / 'ieee-cis'
    paysim_dir = DATA_DIR / 'paysim'
    
    all_ok = True
    
    # Check IEEE-CIS
    ieee_transaction = ieee_dir / 'train_transaction.csv'
    ieee_identity = ieee_dir / 'train_identity.csv'
    
    if ieee_transaction.exists():
        size_mb = ieee_transaction.stat().st_size / (1024 * 1024)
        logger.info(f"✓ IEEE-CIS train_transaction.csv: {size_mb:.1f} MB")
    else:
        logger.warning("✗ IEEE-CIS train_transaction.csv: NOT FOUND")
        all_ok = False
    
    if ieee_identity.exists():
        size_mb = ieee_identity.stat().st_size / (1024 * 1024)
        logger.info(f"✓ IEEE-CIS train_identity.csv: {size_mb:.1f} MB")
    else:
        logger.warning("✗ IEEE-CIS train_identity.csv: NOT FOUND")
        all_ok = False
    
    # Check PaySim
    paysim_file = paysim_dir / 'PS_20174392719_1491204439457_log.csv'
    
    if paysim_file.exists():
        size_mb = paysim_file.stat().st_size / (1024 * 1024)
        logger.info(f"✓ PaySim dataset: {size_mb:.1f} MB")
    else:
        logger.warning("✗ PaySim dataset: NOT FOUND")
        all_ok = False
    
    if all_ok:
        logger.info("")
        logger.info("✓ All datasets ready for training!")
        logger.info("")
        logger.info("Next step: Run training with real datasets:")
        logger.info("  python scripts/train_with_datasets.py")
    else:
        logger.warning("")
        logger.warning("Some datasets are missing. Training may fall back to synthetic data.")
    
    return all_ok


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description='Download fraud detection training datasets'
    )
    parser.add_argument(
        '--ieee-only',
        action='store_true',
        help='Download only IEEE-CIS dataset'
    )
    parser.add_argument(
        '--paysim-only',
        action='store_true',
        help='Download only PaySim dataset'
    )
    parser.add_argument(
        '--verify-only',
        action='store_true',
        help='Only verify existing datasets'
    )
    
    args = parser.parse_args()
    
    # Create data directory
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    
    if args.verify_only:
        verify_datasets()
        return
    
    # Check Kaggle API
    if not check_kaggle_api():
        logger.info("")
        logger.info("Continuing without Kaggle API - checking for manually downloaded files...")
        verify_datasets()
        return
    
    # Download datasets
    if args.ieee_only:
        download_ieee_cis()
    elif args.paysim_only:
        download_paysim()
    else:
        download_ieee_cis()
        download_paysim()
    
    # Verify downloads
    verify_datasets()


if __name__ == '__main__':
    main()
