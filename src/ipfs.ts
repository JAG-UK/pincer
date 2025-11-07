function getIpfsUrl(cid: string, gateway: string = ''): string {
  // If gateway is provided, use standard path-based format
  if (gateway) {
    return `${gateway}/${cid}`;
  }
  
  // Otherwsie use dweb.link subdomain format
  cid = cid.replace('ipfs://', '').replace('/ipfs/', '').replace(/^\//, '');
  return `https://${cid}.ipfs.dweb.link`;
}

export async function fetchFromIpfs(cid: string, gateway: string = ''): Promise<Buffer> {
  const url = getIpfsUrl(cid, gateway);
  console.debug(`Fetching from IPFS: ${url}`);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch from IPFS: ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export async function fetchJsonFromIpfs(cid: string, gateway: string = ''): Promise<any> {
  const content = await fetchFromIpfs(cid, gateway);
  return JSON.parse(content.toString('utf-8'));
}

export async function* streamFromIpfs(cid: string, gateway: string = ''): AsyncGenerator<Buffer> {
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

