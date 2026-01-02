import { generateDummyPassword } from './db/utils';

export const isProductionEnvironment = process.env.NODE_ENV === 'production';
export const isDevelopmentEnvironment = process.env.NODE_ENV === 'development';
export const isTestEnvironment = Boolean(
  process.env.PLAYWRIGHT_TEST_BASE_URL ||
    process.env.PLAYWRIGHT ||
    process.env.CI_PLAYWRIGHT,
);

// Vercel-specific environment detection
// VERCEL_ENV is "production" | "preview" | "development"
// Note: NODE_ENV is "production" for both production and preview deployments on Vercel
export const isVercelProductionDeployment =
  process.env.VERCEL_ENV === 'production';
export const isVercelPreviewDeployment = process.env.VERCEL_ENV === 'preview';
export const isVercelDeployment = Boolean(process.env.VERCEL);

export const DUMMY_PASSWORD = generateDummyPassword();
