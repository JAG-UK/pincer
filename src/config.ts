import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';

export interface Config {
  mappingFile: string;
  storageDir: string;
  host: string;
  port: number;
}

export function loadConfig(): Config {
  return {
    mappingFile: process.env.PINCER_MAPPING_FILE || 'image_mapping.json',
    storageDir: process.env.PINCER_STORAGE_DIR || 'storage',
    host: process.env.PINCER_HOST || '0.0.0.0',
    port: parseInt(process.env.PINCER_PORT || '5002', 10), // Changed from 5000 to avoid macOS Control Center conflict
  };
}

