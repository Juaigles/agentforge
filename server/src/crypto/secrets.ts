// Cifrado en reposo de secretos (API keys) con AES-256-GCM.
// La clave maestra se genera en el primer arranque y se guarda en <dataDir>/secret.key.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export class SecretBox {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('La clave maestra debe tener 32 bytes.');
  }

  static fromKeyFile(file: string): SecretBox {
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600 });
    }
    return new SecretBox(Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64'));
  }

  static ephemeral(): SecretBox {
    return new SecretBox(randomBytes(32));
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
  }

  decrypt(payload: string): string {
    const [version, iv, tag, data] = payload.split(':');
    if (version !== 'v1' || !iv || !tag || data === undefined) throw new Error('Formato de secreto no reconocido.');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  }
}
