const fs = require('fs');
const { dkimVerify } = require('./lib/dkim/verify');

// `message` is either a String, a Buffer or a Readable Stream
const eml = fs.readFileSync('./Message14960479880043215677.eml');

const txtDomainKeyPath = './_domainkey.txt';
const customTxt = fs.existsSync(txtDomainKeyPath) ? fs.readFileSync(txtDomainKeyPath, 'utf-8') : null;

const verify = async () => {
  const result = await dkimVerify(eml, {
    customTxt
  });

  for (let data of result.results) {
      console.log(data);
  }
}

verify();