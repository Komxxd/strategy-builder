/**
 * DigitalOcean Service
 * Handles provisioning and managing Worker Droplets.
 */
const crypto = require('crypto');

const DO_API_URL = 'https://api.digitalocean.com/v2';
const DO_API_KEY = process.env.DIGITALOCEAN_API_KEY;

// Verify we have the key, throw warning if not (so the app doesn't crash on startup, but fails on usage)
const checkConfig = () => {
    if (!DO_API_KEY) {
        throw new Error('DIGITALOCEAN_API_KEY is not defined in environment variables.');
    }
};

/**
 * Helper for making DO API requests
 */
async function doRequest(endpoint, method = 'GET', body = null) {
    checkConfig();
    
    const options = {
        method,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${DO_API_KEY}`
        }
    };
    
    if (body) {
        options.body = JSON.stringify(body);
    }

    const response = await fetch(`${DO_API_URL}${endpoint}`, options);
    
    if (method === 'DELETE' && response.status === 204) {
        return { success: true };
    }
    
    const data = await response.json();

    if (!response.ok) {
        throw new Error(`DigitalOcean API Error: ${data.message || response.statusText}`);
    }

    return data;
}

const fs = require('fs');
const path = require('path');

/**
 * Creates a new Worker Droplet for a user
 * @param {string} userId - The user ID to tag the droplet
 * @param {string} env - 'dev' or 'prod'
 * @param {string} masterServerUrl - The URL of the Master server (for WebSockets)
 * @param {string} workerSecret - The shared secret to authenticate the WebSocket
 * @param {string} workerId - The UUID of the worker node record
 * @returns {Promise<Object>} Droplet data
 */
async function createWorkerDroplet(userId, env = 'dev', masterServerUrl, workerSecret, workerId) {
    // We use the cheapest droplet size in Bangalore (blr1)
    const size = 's-1vcpu-512mb-10gb'; 
    const region = 'blr1';
    
    // Generate a unique name for the droplet
    const dropletName = `worker-${env}-${userId.substring(0, 8)}-${crypto.randomBytes(4).toString('hex')}`;

    // Read the worker script from disk and base64 encode it to safely pass it in YAML
    const workerScriptPath = path.join(__dirname, '../worker-node/worker.js');
    let workerScriptContent = '';
    try {
        workerScriptContent = fs.readFileSync(workerScriptPath, 'utf8');
    } catch (e) {
        console.error("Could not read worker.js. Ensure it exists in src/worker-node/worker.js");
        throw e;
    }
    const workerScriptBase64 = Buffer.from(workerScriptContent).toString('base64');

    const packageJsonContent = Buffer.from(JSON.stringify({
        name: "strategy-worker",
        version: "1.0.0",
        dependencies: {
            "socket.io-client": "^4.7.0",
            "smartapi-javascript": "^1.0.27",
            "speakeasy": "^2.0.0"
        }
    })).toString('base64');

    // Cloud-Init Script: Writes files, installs Node & PM2, and starts the worker
    const cloudInit = `#cloud-config
write_files:
  - path: /root/worker.js
    encoding: b64
    content: ${workerScriptBase64}
  - path: /root/package.json
    encoding: b64
    content: ${packageJsonContent}
  - path: /root/.env
    content: |
      MASTER_SERVER_URL=${masterServerUrl}
      WORKER_ID=${workerId}
      WORKER_SECRET=${workerSecret}

runcmd:
  - curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  - sudo apt-get install -y nodejs
  - npm install -g pm2
  - cd /root
  - npm install
  - pm2 start worker.js --name "angel-worker"
  - pm2 save
  - pm2 startup
  - echo "Worker Droplet Initialized and running" > /root/init.log
`;

    const payload = {
        name: dropletName,
        region,
        size,
        image: 'ubuntu-24-04-x64', // Base Ubuntu image
        tags: [`${env}-worker`, `user-${userId}`],
        user_data: cloudInit
    };

    const data = await doRequest('/droplets', 'POST', payload);
    return data.droplet;
}

/**
 * Gets a Droplet by ID, useful for polling its IP address after creation
 * @param {string} dropletId
 * @returns {Promise<Object>}
 */
async function getDroplet(dropletId) {
    const data = await doRequest(`/droplets/${dropletId}`, 'GET');
    return data.droplet;
}

/**
 * Polls the Droplet API until it receives an IPv4 address
 * DigitalOcean takes a few seconds to assign an IP after creation.
 * @param {string} dropletId 
 * @param {number} maxAttempts 
 * @returns {Promise<string>} The public IPv4 address
 */
async function waitForDropletIp(dropletId, maxAttempts = 10) {
    for (let i = 0; i < maxAttempts; i++) {
        const droplet = await getDroplet(dropletId);
        
        // Find the public IPv4 address
        if (droplet.networks && droplet.networks.v4) {
            const publicNetwork = droplet.networks.v4.find(net => net.type === 'public');
            if (publicNetwork && publicNetwork.ip_address) {
                return publicNetwork.ip_address;
            }
        }
        
        // Wait 5 seconds before polling again
        await new Promise(resolve => setTimeout(resolve, 5000));
    }
    
    throw new Error('Timeout waiting for DigitalOcean to assign an IP address.');
}

/**
 * Deletes a Droplet
 * @param {string} dropletId 
 */
async function deleteDroplet(dropletId) {
    await doRequest(`/droplets/${dropletId}`, 'DELETE');
    return true;
}

module.exports = {
    createWorkerDroplet,
    getDroplet,
    waitForDropletIp,
    deleteDroplet
};
