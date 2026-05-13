"""
PostgreSQL connection manager with connection pooling.
"""

from sqlalchemy import create_engine, text
from sqlalchemy.pool import QueuePool
from typing import Any, Dict, List, Optional
import logging

logger = logging.getLogger(__name__)


class DatabaseConnection:
    """
    PostgreSQL connection manager with connection pooling.
    
    Features:
    - Connection pooling for efficiency
    - Automatic connection health checks
    - Error handling and reconnection
    
    Example:
        >>> db = DatabaseConnection(config)
        >>> result = db.execute("SELECT COUNT(*) FROM transactions")
        >>> db.close()
    """
    
    def __init__(self, config):
        """
        Initialize database connection.
        
        Args:
            config: Configuration object with PostgreSQL settings
        """
        connection_string = (
            f"postgresql://{config.POSTGRES_USER}:{config.POSTGRES_PASSWORD}@"
            f"{config.POSTGRES_HOST}:{config.POSTGRES_PORT}/{config.POSTGRES_DB}"
        )
        
        try:
            self.engine = create_engine(
                connection_string,
                poolclass=QueuePool,
                pool_size=5,              # Max 5 connections in pool
                max_overflow=10,          # Allow 10 additional connections
                pool_pre_ping=True,       # Verify connections before use
                pool_recycle=3600,        # Recycle connections after 1 hour
                echo=False                # Set to True for SQL debug logging
            )
            
            # Test connection
            with self.engine.connect() as conn:
                conn.execute(text("SELECT 1"))
            
            logger.info(
                f"✅ Database connected: {config.POSTGRES_HOST}:{config.POSTGRES_PORT}/{config.POSTGRES_DB}"
            )
            
        except Exception as e:
            logger.error(f"❌ Failed to connect to database: {e}")
            raise
    
    def execute(
        self, 
        query: str, 
        params: Optional[Dict[str, Any]] = None
    ) -> List[Any]:
        """
        Execute a query and return results.
        
        Args:
            query: SQL query string
            params: Optional query parameters
        
        Returns:
            List of result rows
        
        Example:
            >>> results = db.execute(
            ...     "SELECT * FROM transactions WHERE amount > :amt",
            ...     {"amt": 10000}
            ... )
        """
        try:
            with self.engine.connect() as conn:
                result = conn.execute(text(query), params or {})
                return result.fetchall()
        except Exception as e:
            logger.error(f"Query execution failed: {e}")
            logger.error(f"Query: {query}")
            raise
    
    def execute_df(self, query: str, params: Optional[Dict[str, Any]] = None):
        """
        Execute query and return pandas DataFrame.
        
        Args:
            query: SQL query string
            params: Optional query parameters
        
        Returns:
            pandas DataFrame with results
        """
        import pandas as pd
        
        try:
            with self.engine.connect() as conn:
                df = pd.read_sql(text(query), conn, params=params or {})
            return df
        except Exception as e:
            logger.error(f"DataFrame query failed: {e}")
            raise
    
    def close(self):
        """Close all database connections."""
        try:
            self.engine.dispose()
            logger.info("Database connections closed")
        except Exception as e:
            logger.error(f"Error closing database connections: {e}")
