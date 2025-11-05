import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import express from 'express';
import type { Server } from 'http';
import { networkInterfaces } from 'os';

const execAsync = promisify(exec);

const PINCER_PORT = 5001;
const PINCER_HOST = 'localhost';

// Get host IP address for Docker (macOS Docker Desktop needs IP, not localhost)
function getHostIP(): string {
  const interfaces = networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    const nets = interfaces[name];
    if (!nets) continue;
    for (const net of nets) {
      // Skip internal addresses
      // Check for IPv4: family can be 'IPv4' (string) or 4 (number) depending on Node.js version
      // TypeScript types say it's always a string, but runtime it can be a number
      const family = net.family as string | number;
      const isIPv4 = family === 'IPv4' || family === 4;
      if (isIPv4 && !net.internal && net.address) {
        // Prefer en0 (primary interface) on macOS
        if (process.platform === 'darwin' && name === 'en0') {
          return net.address;
        }
      }
    }
  }
  // If we didn't find en0, try any non-internal IPv4
  for (const name of Object.keys(interfaces)) {
    const nets = interfaces[name];
    if (!nets) continue;
    for (const net of nets) {
      const family = net.family as string | number;
      const isIPv4 = family === 'IPv4' || family === 4;
      if (isIPv4 && !net.internal && net.address) {
        return net.address;
      }
    }
  }
  return 'localhost'; // Fallback
}

const HOST_IP = getHostIP();
const DOCKER_HOST = process.platform === 'darwin' || process.platform === 'win32' 
  ? HOST_IP 
  : 'localhost';
const TEST_REGISTRY = `${DOCKER_HOST}:${PINCER_PORT}`;
const TEST_IMAGE = `test/pincer-self-test:latest`;

describe('PinCeR Self-Containerization Test', () => {
  let server: Server | null = null;
  const testStorageDir = join(process.cwd(), 'test_storage');
  const testMappingFile = join(process.cwd(), 'test_image_mapping.json');

  beforeAll(async () => {
    // Clean up test files
    if (existsSync(testMappingFile)) {
      rmSync(testMappingFile);
    }
    if (existsSync(testStorageDir)) {
      rmSync(testStorageDir, { recursive: true });
    }

    // Set environment variables for test
    process.env.PINCER_PORT = String(PINCER_PORT);
    process.env.PINCER_MAPPING_FILE = testMappingFile;
    process.env.PINCER_STORAGE_DIR = testStorageDir;
    process.env.PINCER_HOST = '0.0.0.0'; // Bind to all interfaces so Docker can connect

    // Dynamically import to avoid immediate execution
    const { app, initialize } = await import('../src/index.js');
    
    // Initialize and start server
    initialize();
    
    // Debug: Show what IP we detected
    console.log(`🔍 Detected host IP: ${HOST_IP}`);
    console.log(`🔍 Platform: ${process.platform}`);
    console.log(`🔍 Docker host: ${DOCKER_HOST}`);
    console.log(`🔍 Test registry: ${TEST_REGISTRY}`);
    
    await new Promise<void>((resolve, reject) => {
      // Bind to 0.0.0.0 so Docker can connect
      server = app.listen(PINCER_PORT, '0.0.0.0', () => {
        console.log(`✅ PinCeR test server started on 0.0.0.0:${PINCER_PORT}`);
        resolve();
      });
      
      server.on('error', (error) => {
        console.error('Server error:', error);
        reject(error);
      });
    });

    // Wait a bit for server to be fully ready
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Verify server is running from multiple interfaces
    // Try IPv4 first (IPv6 often fails on macOS)
    const healthUrls = [
      `http://127.0.0.1:${PINCER_PORT}/health`,
      `http://localhost:${PINCER_PORT}/health`,
      `http://${HOST_IP}:${PINCER_PORT}/health`,
    ];
    
    let serverHealthy = false;
    for (const url of healthUrls) {
      try {
        const response = await fetch(url);
        if (response.ok) {
          const health = await response.json();
          if (health.status === 'healthy') {
            serverHealthy = true;
            console.log(`✅ Server health check passed via ${url}`);
            break;
          }
        }
      } catch (error) {
        // IPv6 (::1) often fails on macOS, that's OK
        if (!url.includes('::1')) {
          console.warn(`Health check failed for ${url}:`, error);
        }
      }
    }
    
    if (!serverHealthy) {
      throw new Error('Server not responding to health checks');
    }
    
    // Test the API version endpoint that Docker will use (use IP address)
    // Try multiple addresses - Docker might use IP but Node.js might need localhost
    const apiUrls = [
      `http://127.0.0.1:${PINCER_PORT}/v2/`,
      `http://${HOST_IP}:${PINCER_PORT}/v2/`,
      `http://localhost:${PINCER_PORT}/v2/`,
    ];
    
    let apiVerified = false;
    for (const url of apiUrls) {
      try {
        const apiResponse = await fetch(url);
        if (apiResponse.ok) {
          const apiData = await apiResponse.json();
          if (apiData.version === '2.0') {
            apiVerified = true;
            console.log(`✅ OCI API version endpoint verified via ${url}`);
            break;
          }
        }
      } catch (error) {
        // Try next URL
        continue;
      }
    }
    
    if (!apiVerified) {
      console.warn(`⚠️  Could not verify API endpoint from Node.js, but Docker will use ${HOST_IP}:${PINCER_PORT}`);
      console.warn(`   (This is OK - Docker Desktop networking is different from Node.js networking)`);
      // Don't fail - Docker might still be able to reach it
    } else {
      console.log(`   Using ${HOST_IP}:${PINCER_PORT} for Docker operations`);
    }
  }, 30000);

  afterAll(async () => {
    // Stop server
    if (server) {
      await new Promise<void>((resolve) => {
        server!.close(() => {
          console.log('✅ PinCeR test server stopped');
          resolve();
        });
      });
      server = null;
    }

    // Don't clean up test files here - let them persist for inspection
    // They will be cleaned up on the next run by beforeAll
    console.log(`📁 Test storage preserved at: ${testStorageDir}`);
    console.log(`📁 Test mapping preserved at: ${testMappingFile}`);
    console.log('   (These will be cleaned up on the next test run)');
  });

  it('should containerize PinCeR and push it to itself', async () => {
    console.log('🐳 Building PinCeR Docker image...');
    try {
      const { stdout: buildOutput } = await execAsync(
        `docker build -t ${TEST_REGISTRY}/${TEST_IMAGE} .`,
        { cwd: process.cwd() }
      );
      console.log('✅ Docker build completed');
    } catch (error: any) {
      console.error('❌ Docker build failed:', error.stdout || error.message);
      if (error.stderr) {
        console.error('Build stderr:', error.stderr);
      }
      throw error;
    }

    console.log('🏷️  Image tagged for local registry');

    console.log(`📤 Pushing ${TEST_IMAGE} to PinCeR at ${TEST_REGISTRY}...`);
    console.log(`   (Docker will connect to http://${TEST_REGISTRY}/v2/)`);
    console.log(`   (Using host IP: ${HOST_IP})`);
    
    // First verify Docker can reach the registry from Node.js
    // Try localhost first (works from Node.js), then IP (works from Docker)
    const testUrls = [
      `http://127.0.0.1:${PINCER_PORT}/v2/`,
      `http://localhost:${PINCER_PORT}/v2/`,
      `http://${HOST_IP}:${PINCER_PORT}/v2/`,
    ];
    
    let registryAccessible = false;
    for (const url of testUrls) {
      try {
        const testResponse = await fetch(url);
        if (testResponse.ok) {
          registryAccessible = true;
          console.log(`✅ Registry accessible from test environment via ${url}`);
          break;
        }
      } catch (error) {
        // Try next URL
        continue;
      }
    }
    
    if (!registryAccessible) {
      console.warn(`⚠️  Could not verify registry from Node.js, but Docker will use ${TEST_REGISTRY}`);
      console.warn(`   (This is OK - Docker Desktop networking is different)`);
      // Don't fail - Docker might still be able to reach it
    }
    
    // Test Docker can reach the registry (using host IP for macOS Docker Desktop)
    console.log(`🔍 Testing Docker can reach registry at ${TEST_REGISTRY}...`);
    console.log(`   (Using ${HOST_IP} for Docker Desktop compatibility)`);
    
    try {
      // Test if Docker can reach the registry
      // We expect either a 404 (good - registry is reachable) or connection error (bad)
      const { stdout: dockerTest, stderr: dockerTestStderr } = await execAsync(
        `docker pull ${TEST_REGISTRY}/nonexistent:tag 2>&1 || true`,
        { timeout: 10000 }
      );
      
      const fullOutput = (dockerTest || '') + (dockerTestStderr || '');
      
      // Check for connection errors - these mean Docker can't reach the registry
      const isConnectionError = fullOutput.includes('connection refused') || 
                                fullOutput.includes('dial tcp') ||
                                fullOutput.includes('timeout') || 
                                fullOutput.includes('cannot connect') ||
                                fullOutput.includes('deadline exceeded') ||
                                fullOutput.includes('no such host') ||
                                fullOutput.includes('connect: connection refused');
      
      // Check for TLS errors - Docker is trying HTTPS instead of HTTP
      const isTLSError = fullOutput.includes('TLS handshake') || 
                         fullOutput.includes('tls:') ||
                         fullOutput.includes('x509') ||
                         fullOutput.includes('certificate') ||
                         fullOutput.includes('HTTPS');
      
      if (isTLSError) {
        console.error(`❌ Docker is trying HTTPS instead of HTTP for ${TEST_REGISTRY}`);
        console.error('');
        console.error('📋 Docker Desktop needs insecure-registries configured:');
        console.error('');
        console.error('   1. Open Docker Desktop → Settings → Docker Engine');
        console.error('   2. Add to JSON configuration:');
        console.error('   {');
        console.error(`     "insecure-registries": ["${HOST_IP}:${PINCER_PORT}", "localhost:${PINCER_PORT}"]`);
        console.error('   }');
        console.error('   3. Click "Apply & Restart" (IMPORTANT: Must restart!)');
        console.error('');
        console.error('   After restarting, verify:');
        console.error('   docker info | grep -i insecure');
        console.error(`   Should show: ${HOST_IP}:${PINCER_PORT} and/or localhost:${PINCER_PORT}`);
        throw new Error(`Docker is using HTTPS - insecure-registries not configured correctly`);
      }
      
      if (isConnectionError) {
        console.error(`❌ Docker cannot reach the registry at ${TEST_REGISTRY}`);
        console.error('');
        console.error('📋 Docker Desktop configuration needed:');
        console.error('');
        console.error('   Docker Desktop → Settings → Docker Engine → Add:');
        console.error('   {');
        console.error(`     "insecure-registries": ["localhost:${PINCER_PORT}"]`);
        console.error('   }');
        console.error('');
        console.error('   Then click "Apply & Restart"');
        console.error('');
        console.error('   If it still fails, try:');
        console.error('   1. Ensure Docker Desktop is running');
        console.error('   2. Check if port 5001 is accessible: curl http://localhost:5001/v2/');
        console.error('   3. Try restarting Docker Desktop');
        throw new Error(`Docker cannot reach registry at ${TEST_REGISTRY} - check Docker Desktop settings`);
      }
      
      // If we get manifest not found, 404, or access denied (but not connection error), Docker can reach it
      if (fullOutput.includes('manifest unknown') || 
          fullOutput.includes('not found') || 
          fullOutput.includes('404') ||
          fullOutput.includes('pull access denied') ||
          fullOutput.includes('repository does not exist')) {
        console.log('✅ Docker can reach registry (got expected error for nonexistent image)');
      } else {
        console.log('✅ Docker can reach registry');
      }
    } catch (error: any) {
      // If timeout, Docker can't reach it
      if (error.message.includes('timeout') || error.code === 'ETIMEDOUT' || error.message.includes('reach registry')) {
        throw error;
      }
      // Other errors might be OK, continue with push
      console.warn('⚠️  Docker registry test had issues, but continuing...');
    }
    
    try {
      const { stdout: pushOutput, stderr: pushStderr } = await execAsync(
        `docker push ${TEST_REGISTRY}/${TEST_IMAGE}`,
        { timeout: 120000 } // 2 minute timeout
      );
      
      if (pushStderr && !pushStderr.includes('digest:') && !pushStderr.includes('pushed')) {
        console.warn('Push warnings:', pushStderr);
      }
      
      console.log('✅ Push completed');
      if (pushOutput) console.log('Push output:', pushOutput);
      
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const manifestResponse = await fetch(
        `http://${HOST_IP}:${PINCER_PORT}/v2/${TEST_IMAGE.split(':')[0]}/manifests/${TEST_IMAGE.split(':')[1]}`
      );
      
      expect(manifestResponse.ok).toBe(true);
      const manifest = await manifestResponse.json();
      expect(manifest).toBeDefined();
      expect(manifest.schemaVersion).toBeDefined();
      
      console.log('✅ Successfully pushed PinCeR to itself!');
      console.log('📋 Manifest schema version:', manifest.schemaVersion);
      
      expect(existsSync(testMappingFile)).toBe(true);
      
    } catch (error: any) {
      const errorMsg = error.message || error.stderr || '';
      
      // Check for connection timeout errors
      if (errorMsg.includes('request canceled') || errorMsg.includes('timeout') || errorMsg.includes('connection refused')) {
        console.error('❌ Connection timeout - Docker cannot reach the registry');
        console.error('   This usually means:');
        console.error('   1. The server is not bound to 0.0.0.0 (check server logs)');
        console.error('   2. Docker Desktop network settings are blocking connections');
        console.error('   3. Firewall is blocking port', PINCER_PORT);
        console.error('   Try: curl http://localhost:' + PINCER_PORT + '/v2/');
        throw error;
      }
      
      // Check for TLS/HTTPS errors
      if (errorMsg.includes('TLS handshake') || 
          errorMsg.includes('tls:') ||
          errorMsg.includes('x509') || 
          errorMsg.includes('certificate') ||
          errorMsg.includes('HTTPS') ||
          errorMsg.includes('insecure')) {
        console.error('❌ Push failed - Docker is trying HTTPS instead of HTTP');
        console.error('');
        console.error('📋 Docker Desktop needs insecure-registries configured:');
        console.error('');
        console.error('   1. Open Docker Desktop → Settings → Docker Engine');
        console.error('   2. Add to JSON configuration:');
        console.error('   {');
        console.error(`     "insecure-registries": ["${HOST_IP}:${PINCER_PORT}", "localhost:${PINCER_PORT}"]`);
        console.error('   }');
        console.error('   3. Click "Apply & Restart" (MUST restart Docker Desktop!)');
        console.error('');
        console.error('   Verify after restart: docker info | grep -i insecure');
        throw error;
      }
      console.error('❌ Push failed:', error.stdout || error.message);
      if (error.stderr) {
        console.error('Push stderr:', error.stderr);
      }
      throw error;
    }
  }, 180000);

  it('should be able to pull PinCeR from itself', async () => {
    // Skip if push failed
    if (!existsSync(testMappingFile)) {
      console.warn('⚠️  Pull test skipped - push test did not complete successfully');
      return;
    }

    console.log(`📥 Pulling ${TEST_IMAGE} from PinCeR...`);
    try {
      try {
        await execAsync(`docker rmi ${TEST_REGISTRY}/${TEST_IMAGE} 2>/dev/null || true`);
      } catch {
        // Ignore errors
      }

      const { stdout: pullOutput, stderr: pullStderr } = await execAsync(
        `docker pull ${TEST_REGISTRY}/${TEST_IMAGE}`,
        { timeout: 60000 }
      );
      
      console.log('✅ Pull completed');
      if (pullOutput) console.log('Pull output:', pullOutput);
      
      const { stdout: imageList } = await execAsync(
        `docker images ${TEST_REGISTRY}/${TEST_IMAGE} --format "{{.Repository}}:{{.Tag}}"`
      );
      expect(imageList.trim()).toBe(`${TEST_REGISTRY}/${TEST_IMAGE}`);
      
      console.log('✅ Successfully pulled PinCeR from itself!');
      console.log('🦞 PinCeR is now fully self-hosting!');
    } catch (error: any) {
      const errorMsg = error.message || error.stderr || '';
      
      // Check for connection timeout errors
      if (errorMsg.includes('request canceled') || errorMsg.includes('timeout') || errorMsg.includes('connection refused')) {
        console.error('❌ Connection timeout - Docker cannot reach the registry for pull');
        console.error('   This usually means:');
        console.error('   1. The server is not bound to 0.0.0.0 (check server logs)');
        console.error('   2. Docker Desktop network settings are blocking connections');
        console.error('   3. Firewall is blocking port', PINCER_PORT);
        throw error;
      }
      
      if (errorMsg.includes('insecure') || errorMsg.includes('certificate')) {
        console.warn('⚠️  Pull failed - Docker may need insecure registry configuration:');
        console.warn('   Add to /etc/docker/daemon.json (or ~/.docker/daemon.json on macOS):');
        console.warn('   { "insecure-registries": ["localhost:5001"] }');
        console.warn('   Then restart Docker daemon');
        throw error; // Actually fail the test instead of skipping
      }
      
      console.error('❌ Pull failed:', error.message);
      throw error;
    }
  }, 60000);
});
