import { isIP, SocketAddress } from 'node:net';

const CLIENT_HEADER='x-bb-client-ip';
const MAX_IPS=64;
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)
  &&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const onlyKeys=(value,keys)=>plain(value)&&Reflect.ownKeys(value).every(key=>keys.includes(key));
const deny=()=>{throw Object.assign(new Error('Access denied'),{statusCode:403});};

function canonicalIp(value) {
  // isIP accepts scoped IPv6 literals; explicitly refuse zone IDs, brackets,
  // ports, whitespace, ranges and forwarding lists before using Node's parser.
  if(typeof value!=='string'||value.length>45||!value||!/^[0-9a-fA-F:.]+$/.test(value))return null;
  const family=isIP(value);if(!family)return null;
  let address;
  try {address=new SocketAddress({address:value,family:family===4?'ipv4':'ipv6'}).address;}
  catch {return null;}
  // Node canonicalizes both hexadecimal and dotted mapped IPv6 to this form.
  // A dual-stack listener must not give one IPv4 client two quota identities.
  if(address.startsWith('::ffff:')&&isIP(address.slice(7))===4)address=address.slice(7);
  if(isIP(address)===4) {
    if(address==='0.0.0.0'||Number(address.split('.')[0])>=224)return null;
  } else if(address==='::'||address.startsWith('ff'))return null;
  return address;
}

function addresses(value) {
  if(!Array.isArray(value)||value.length===0||value.length>MAX_IPS)throw new TypeError('A bounded exact-IP allowlist is required');
  const result=new Set();
  for(const item of value) {
    const address=canonicalIp(item);
    if(!address)throw new TypeError('Allowlist entries must be exact unicast IP literals');
    result.add(address);
  }
  return result;
}

function proxyClientIp(req) {
  const headers=req?.headers,raw=req?.rawHeaders;
  if(!headers||typeof headers!=='object'||Array.isArray(headers)||!Array.isArray(raw)
      ||raw.length>200||raw.length%2!==0)return null;
  let count=0,rawValue,total=0;
  for(let index=0;index<raw.length;index+=2) {
    const name=raw[index],value=raw[index+1];
    if(typeof name!=='string'||typeof value!=='string')return null;
    total+=Buffer.byteLength(name)+Buffer.byteLength(value);if(total>16384)return null;
    if(name.toLowerCase()===CLIENT_HEADER){count++;rawValue=value;}
  }
  if(count!==1||!Object.hasOwn(headers,CLIENT_HEADER)
      ||Object.keys(headers).filter(name=>name.toLowerCase()===CLIENT_HEADER).length!==1
      ||typeof headers[CLIENT_HEADER]!=='string'||headers[CLIENT_HEADER]!==rawValue)return null;
  return canonicalIp(rawValue);
}

/**
 * Mandatory network gate, independent of SAML/session authorization.
 * Production allowedClientIps must be the approved VPN/SASE public egresses.
 * This parser validates exact address syntax, not public routability or VPN
 * ownership; reserved documentation/loopback fixtures need no runtime bypass.
 *
 * A proxy must overwrite (never append) x-bb-client-ip from its verified client
 * address. Its peer IPs are trusted infrastructure, never a browser claim.
 * Restrict origin reachability to those peers as an additional network control.
 */
export function createNetworkAccessPolicy(config) {
  if(!onlyKeys(config,['allowedClientIps','trustedProxy'])||!Object.hasOwn(config,'allowedClientIps'))throw new TypeError('An explicit network access configuration is required');
  const clients=addresses(config.allowedClientIps);
  let peers=null;
  if(Object.hasOwn(config,'trustedProxy')) {
    const proxy=config.trustedProxy;
    if(!onlyKeys(proxy,['peerIps','clientIpHeader'])||proxy.clientIpHeader!==CLIENT_HEADER
        ||!Object.hasOwn(proxy,'peerIps')||!Object.hasOwn(proxy,'clientIpHeader'))throw new TypeError('A pinned proxy and dedicated client-IP header are required');
    peers=addresses(proxy.peerIps);
  }
  return Object.freeze({
    authorize(req) {
      // Malformed transport evidence and unexpected accessors both deny without
      // reflecting addresses, headers or implementation errors to the caller.
      let client;
      try {
        const peer=canonicalIp(req?.socket?.remoteAddress);
        if(!peer||(peers&&!peers.has(peer)))deny();
        client=peers?proxyClientIp(req):peer;
        if(!client||!clients.has(client))deny();
      } catch {deny();}
      return client;
    },
  });
}
