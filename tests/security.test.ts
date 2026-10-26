import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { hashPassword, verifyPassword, credentialCipher } from '@personal-context/security';
test('password verification and authenticated encryption reject forged inputs',async()=>{
 const hash=await hashPassword('long-test-password');
 assert.equal(await verifyPassword('long-test-password',hash),true);
 assert.equal(await verifyPassword('wrong-password',hash),false);
 assert.equal(await verifyPassword('x','invalid'),false);
 const cipher=credentialCipher(randomBytes(32).toString('base64'));
 const encrypted=cipher.encrypt('provider-token');
 assert.ok(!encrypted.includes('provider-token'));assert.equal(cipher.decrypt(encrypted),'provider-token');
 const parts=encrypted.split('.');parts[2]=Buffer.from('forged').toString('base64');assert.throws(()=>cipher.decrypt(parts.join('.')),/decryption failed/);
 assert.throws(()=>credentialCipher('bad-key'),/32-byte/);
});
