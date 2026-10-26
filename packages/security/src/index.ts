import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCallback);
export const token = ():string => randomBytes(32).toString('base64url');
export const digest = (value:string):string => createHash('sha256').update(value).digest('hex');
export async function hashPassword(password:string):Promise<string> {
 if(password.length<12 || password.length>1024) throw new Error('Password must contain 12 to 1024 characters');
 const salt=randomBytes(16).toString('hex');
 const hash=await scrypt(password,salt,64) as Buffer;
 return `scrypt:${salt}:${hash.toString('hex')}`;
}
export async function verifyPassword(password:string,encoded:string):Promise<boolean> {
 if(password.length>1024) return false;
 const [algorithm,salt,hex]=encoded.split(':');
 if(algorithm!=='scrypt' || !/^[a-f0-9]{32}$/.test(salt ?? '') || !/^[a-f0-9]{128}$/.test(hex ?? '')) return false;
 const calculated=await scrypt(password,salt,64) as Buffer;
 return timingSafeEqual(calculated,Buffer.from(hex,'hex'));
}
export function credentialCipher(encodedKey:string) {
 const key=Buffer.from(encodedKey,'base64');
 if(key.length!==32 || key.toString('base64')!==encodedKey) throw new Error('CREDENTIAL_ENCRYPTION_KEY must be a canonical base64 32-byte key');
 return {
  encrypt(value:string):string {
   const iv=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',key,iv);
   const bytes=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
   return [iv,cipher.getAuthTag(),bytes].map(x=>x.toString('base64')).join('.');
  },
  decrypt(value:string):string {
   try {
    const [iv,tag,body,...extra]=value.split('.').map(x=>Buffer.from(x,'base64'));
    if(extra.length||!iv||iv.length!==12||!tag||tag.length!==16||!body) throw new Error();
    const decipher=createDecipheriv('aes-256-gcm',key,iv);decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body),decipher.final()]).toString('utf8');
   } catch { throw new Error('Credential decryption failed'); }
  }
 };
}
