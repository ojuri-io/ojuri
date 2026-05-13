process.env.NODE_ENV = process.env.NODE_ENV || 'development';

export type NODE_ENV = 'development' | 'test' | 'staging' | 'production';

export const getEnv = () => process.env.NODE_ENV as NODE_ENV;
