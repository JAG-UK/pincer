const DEFAULT_IPFS_GATEWAY = 'https://ipfs.io/ipfs/';

function getIpfsUrl(cid: string, gateway: string = DEFAULT_IPFS_GATEWAY): string {
  // Remove any ipfs:// prefix
  cid = cid.replace('ipfs://', '').replace('/ipfs/', '').replace(/^\//, '');

  // Handle dweb.link subdomain format
  if (gateway.includes('dweb.link')) {
    return `https://${cid}.ipfs.dweb.link`;
  }

  // Standard path-based format
  const base = gateway.replace(/\/$/, '');
  return `${base}/${cid}`;
}

export async function fetchFromIpfs(cid: string, gateway: string = DEFAULT_IPFS_GATEWAY): Promise<Buffer> {
  const url = getIpfsUrl(cid, gateway);
  console.debug(`Fetching from IPFS: ${url}`);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch from IPFS: ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export async function fetchJsonFromIpfs(cid: string, gateway: string = DEFAULT_IPFS_GATEWAY): Promise<any> {
  const content = await fetchFromIpfs(cid, gateway);
  return JSON.parse(content.toString('utf-8'));
}

export async function* streamFromIpfs(cid: string, gateway: string = DEFAULT_IPFS_GATEWAY): AsyncGenerator<Buffer> {
  const url = getIpfsUrl(cid, gateway);
  console.debug(`Streaming from IPFS: ${url}`);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to stream from IPFS: ${response.statusText}`);
  }

  if (!response.body) {
    throw new Error('Response body is null');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield Buffer.from(value);
    }
  } finally {
    reader.releaseLock();
  }
}

