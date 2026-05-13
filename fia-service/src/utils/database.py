"""PostgreSQL connection manager. Mirrors mla-service shape."""

from typing import Any, Dict, List, Optional

from sqlalchemy import create_engine, text
from sqlalchemy.pool import QueuePool

from src.utils.logger import get_logger

logger = get_logger("FIA.db")


class DatabaseConnection:
    def __init__(self, config):
        connection_string = (
            f"postgresql://{config.POSTGRES_USER}:{config.POSTGRES_PASSWORD}@"
            f"{config.POSTGRES_HOST}:{config.POSTGRES_PORT}/{config.POSTGRES_DB}"
        )
        self.engine = create_engine(
            connection_string,
            poolclass=QueuePool,
            pool_size=5,
            max_overflow=10,
            pool_pre_ping=True,
            pool_recycle=3600,
            echo=False,
        )
        with self.engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        logger.info(
            "Database connected: %s:%s/%s",
            config.POSTGRES_HOST, config.POSTGRES_PORT, config.POSTGRES_DB,
        )

    def execute_write(self, query: str, params: Optional[Dict[str, Any]] = None) -> int:
        """Execute a write (INSERT/UPDATE/DELETE) inside a transaction. Returns rowcount."""
        with self.engine.begin() as conn:
            result = conn.execute(text(query), params or {})
            return result.rowcount

    def fetch_all(self, query: str, params: Optional[Dict[str, Any]] = None) -> List[Any]:
        with self.engine.connect() as conn:
            result = conn.execute(text(query), params or {})
            return result.fetchall()

    def close(self) -> None:
        self.engine.dispose()
