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

    Configures handlers on the **root** logger so that sub-modules using
    ``logging.getLogger(__name__)`` (e.g. ``src.training.data_loader``)
    inherit the same formatter and emit to the same stream. Without this,
    only the top-level ``MLA`` logger would be visible and every other
    module would silently drop its log lines.

    Args:
        name: Logger name returned to the caller (root is always configured).
        level: Logging level (DEBUG, INFO, WARNING, ERROR, CRITICAL).
        log_file: Optional file path for file logging.

    Returns:
        Configured logger instance.
    """

    numeric_level = getattr(logging, level.upper())

    formatter = logging.Formatter(
        fmt='[%(asctime)s] [%(levelname)-8s] [%(name)s] %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S'
    )

    # Configure root once so sub-module loggers propagate cleanly.
    root_logger = logging.getLogger()
    root_logger.setLevel(numeric_level)
    root_logger.handlers.clear()

    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setLevel(numeric_level)
    console_handler.setFormatter(formatter)
    root_logger.addHandler(console_handler)

    if log_file:
        file_handler = logging.FileHandler(log_file)
        file_handler.setLevel(numeric_level)
        file_handler.setFormatter(formatter)
        root_logger.addHandler(file_handler)

    # Named logger inherits root handlers via propagation.
    logger = logging.getLogger(name)
    logger.setLevel(numeric_level)
    logger.handlers.clear()
    logger.propagate = True

    return logger


# Alias for convenience
get_logger = setup_logger


# Module-level logger for this file
logger = setup_logger(__name__)
