import {mkdir,readFile,writeFile,chmod,access} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
const directory='.local/slack-oauth';await mkdir(directory,{recursive:true,mode:0o700});
const key=`${directory}/key.pem`,cert=`${directory}/cert.pem`;
let existing=true;try{await access(key);await access(cert);}catch{existing=false;}
if(!existing){
 const config=`${directory}/openssl.cnf`;
 await writeFile(config,'[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=extensions\n[dn]\nCN=127.0.0.1\n[extensions]\nsubjectAltName=IP:127.0.0.1,DNS:localhost\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n',{mode:0o600});
 execFileSync('openssl',['req','-x509','-nodes','-newkey','rsa:2048','-sha256','-days','365','-config',config,'-keyout',key,'-out',cert],{stdio:'ignore'});
}
await chmod(key,0o600);await chmod(cert,0o600);
const uri='https://127.0.0.1:5443/api/connections/slack/callback';
let env=await readFile('.env','utf8');const line='SLACK_REDIRECT_URI='+uri;env=/^SLACK_REDIRECT_URI=.*$/m.test(env)?env.replace(/^SLACK_REDIRECT_URI=.*$/m,line):env.trimEnd()+'\n'+line+'\n';await writeFile('.env',env,{mode:0o600});await chmod('.env',0o600);
console.log('Slack callback:',uri);console.log('Local development certificate prepared. No system trust settings were changed.');
