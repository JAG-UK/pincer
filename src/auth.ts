import { Request, Response } from 'express';
import { Buffer } from 'buffer';

/**
 * Extract authentication credentials from OCI registry request
 * 
 * OCI/Docker registries use HTTP Basic Authentication:
 * - Authorization: Basic <base64(username:password)>
 * - For our use case, username can be anything, password is the private key
 * 
 * Alternatively supports Bearer tokens:
 * - Authorization: Bearer <private-key>
 */
export interface AuthCredentials {
  privateKey: string;
  username?: string;
}

/**
 * Extract credentials from Authorization header
 */
export function extractCredentials(req: Request): AuthCredentials | null {
  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
    return null;
  }

  // Try Basic Auth first
  if (authHeader.startsWith('Basic ')) {
    const encoded = authHeader.substring(6);
    try {
      const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
      const [username, password] = decoded.split(':');
      
      if (!password) {
        // If no password, treat the whole thing as the private key
        const privateKey = normalizePrivateKey(decoded);
        return { privateKey, username: undefined };
      }
      
      // Password is the private key - normalize it
      const privateKey = normalizePrivateKey(password);
      return { privateKey, username };
    } catch (error) {
      console.error('Failed to decode Basic Auth:', error);
      return null;
    }
  }

  // Try Bearer token
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    const privateKey = normalizePrivateKey(token);
    return { privateKey, username: undefined };
  }

  return null;
}

/**
 * Normalize private key to ensure it has 0x prefix
 * Ethers.js Wallet accepts both formats, but we normalize for consistency
 */
function normalizePrivateKey(key: string): string {
  // Remove any whitespace
  key = key.trim();
  
  // Add 0x prefix if missing
  if (!key.startsWith('0x')) {
    return `0x${key}`;
  }
  
  return key;
}

/**
 * OCI Distribution Spec authentication middleware
 * 
 * Responds with 401 Unauthorized if no credentials are provided
 * Extracts credentials and attaches them to the request for use in handlers
 */
export function requireAuth(req: Request, res: Response, next: () => void): void {
  const credentials = extractCredentials(req);
  
  if (!credentials) {
    // Return 401 with WWW-Authenticate header per OCI spec
    res.set('WWW-Authenticate', 'Basic realm="PinCeR Registry"');
    res.status(401).json({
      errors: [{
        code: 'UNAUTHORIZED',
        message: 'Authentication required',
        detail: 'Provide credentials via Authorization header (Basic Auth or Bearer token)'
      }]
    });
    return;
  }

  // Attach credentials to request for use in handlers
  (req as any).auth = credentials;
  next();
}

/**
 * Optional authentication middleware
 * Extracts credentials if present but doesn't require them
 */
export function optionalAuth(req: Request, res: Response, next: () => void): void {
  const credentials = extractCredentials(req);
  if (credentials) {
    (req as any).auth = credentials;
  }
  next();
}

