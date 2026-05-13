"""
Structured logging for MLA service.
Provides consistent log formatting across all modules.
"""

import logging
import sys
from datetime import datetime
from typing import Optional


def setup_logger(
    name: str = 'MLA',
    level: str = 'INFO',
    log_file: Optional[str] = None
) -> logging.Logger:
    """
    Set up structured logging for MLA service.
    
    Args:
        name: Logger name
        level: Logging level (DEBUG, INFO, WARNING, ERROR, CRITICAL)
        log_file: Optional file path for file logging
    
    Returns:
        Configured logger instance
    
    Example:
        >>> logger = setup_logger('MLA', 'INFO')
        >>> logger.info("Service starting...")
    """
    
    # Create logger
    logger = logging.getLogger(name)
    logger.setLevel(getattr(logging, level.upper()))
    
    # Remove existing handlers to avoid duplicates
    logger.handlers.clear()
    
    # Console handler
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setLevel(getattr(logging, level.upper()))
    
    # Formatter with timestamp, level, module, and message
    formatter = logging.Formatter(
        fmt='[%(asctime)s] [%(levelname)-8s] [%(name)s] %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S'
    )
    console_handler.setFormatter(formatter)
    logger.addHandler(console_handler)
    
    # Optional file handler
    if log_file:
        file_handler = logging.FileHandler(log_file)
        file_handler.setLevel(getattr(logging, level.upper()))
        file_handler.setFormatter(formatter)
        logger.addHandler(file_handler)
    
    return logger


# Alias for convenience
get_logger = setup_logger


# Module-level logger for this file
logger = setup_logger(__name__)
