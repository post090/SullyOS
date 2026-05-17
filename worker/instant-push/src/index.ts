import { createCloudflareWorker } from '@rei-standard/amsg-instant/adapters/cloudflare';

export interface Env {
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_EMAIL?: string;
  AMSG_CLIENT_TOKEN?: string;
}

export default createCloudflareWorker((env: Env) => ({
  vapid: {
    email: env.VAPID_EMAIL || 'mailto:noreply@example.com',
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  },
  clientToken: env.AMSG_CLIENT_TOKEN,
}));
