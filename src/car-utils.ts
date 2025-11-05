import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import * as raw from 'multiformats/codecs/raw';
import { CarWriter } from '@ipld/car';
import type { Logger } from 'pino';

/**
 * Create a simple CAR file from raw bytes
 * 
 * This creates a minimal CAR file containing a single raw block.
 * The block's CID is computed from the raw bytes using SHA256.
 * 
 * @param data - Raw bytes to wrap in a CAR file
 * @param logger - Logger instance
 * @returns CAR file bytes and the root CID
 */
export async function createCarFromBytes(
  data: Uint8Array,
  logger?: Logger
): Promise<{ carData: Uint8Array; rootCid: CID }> {
  // Compute CID for the raw bytes
  const hash = await sha256.digest(data);
  const cid = CID.create(1, raw.code, hash);
  
  // Create a CAR file with this single block
  const chunks: Uint8Array[] = [];
  
  // Create a writer that collects chunks
  const { writer, out } = CarWriter.create([cid]);
  
  // Read output stream and collect chunks
  const readChunks = async () => {
    for await (const chunk of out) {
      chunks.push(chunk);
    }
  };
  
  // Start reading in parallel
  const readPromise = readChunks();
  
  // Write the block
  await writer.put({ cid, bytes: data });
  await writer.close();
  
  // Wait for all chunks to be read
  await readPromise;
  
  // Combine all chunks into a single Uint8Array
  const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
  const carData = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    carData.set(chunk, offset);
    offset += chunk.length;
  }
  
  logger?.debug({ event: 'car.created', size: carData.length, cid: cid.toString() }, 'Created CAR file from bytes');
  
  return { carData, rootCid: cid };
}

/**
 * Create CAR file from file path
 */
export async function createCarFromFile(
  filePath: string,
  logger?: Logger
): Promise<{ carData: Uint8Array; rootCid: CID }> {
  const fs = await import('fs');
  const fileData = await fs.promises.readFile(filePath);
  return createCarFromBytes(fileData, logger);
}

