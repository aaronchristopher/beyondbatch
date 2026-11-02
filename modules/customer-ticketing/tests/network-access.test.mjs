// All addresses are reserved documentation or loopback fixtures; no live
// UniWell egress or infrastructure configuration belongs in this public repo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createNetworkAccessPolicy } from '../src/security/network-access.mjs';

const client='203.0.113.7',other='198.51.100.8',peer='192.0.2.10';
const config={allowedClientIps:[client],trustedProxy:{peerIps:[peer],clientIpHeader:'x-bb-client-ip'}};
const req=(address,headers={})=>({socket:{remoteAddress:address},headers,
  rawHeaders:Object.entries(headers).flatMap(([name,value])=>[name,value])});
const denied=operation=>assert.throws(operation,error=>error.statusCode===403&&error.message==='Access denied'&&!error.cause);

test('network policy requires a bounded nonempty exact-IP configuration',()=>{
  for(const value of [undefined,null,{},[],{allowedClientIps:[]},{allowedClientIps:'203.0.113.7'},
    {allowedClientIps:Array(65).fill(client)},{allowedClientIps:[client],allowAll:true},
    {allowedClientIps:[client],trustedProxy:null},{allowedClientIps:[client],trustedProxy:true}]) {
    assert.throws(()=>createNetworkAccessPolicy(value),TypeError);
  }
  for(const ip of ['*','0.0.0.0/0',`${client}/32`,'2001:db8::/64','example.test','',null,7,
    `${client}:443`,'[2001:db8::1]','[2001:db8::1]:443','fe80::1%eth0','fe80::1%1',
    `${client} `,` ${client}`,`${client}\n`,'203.000.113.7','0xcb007107','3405803783',
    `${client}, ${other}`,'0.0.0.0','::','::ffff:0.0.0.0','224.0.0.1','ff02::1','255.255.255.255']) {
    assert.throws(()=>createNetworkAccessPolicy({allowedClientIps:[ip]}),TypeError,String(ip));
  }
});

test('direct mode accepts only the configured socket addresses',()=>{
  const policy=createNetworkAccessPolicy({allowedClientIps:[client,'2001:db8::1','127.0.0.1']});
  assert.equal(policy.authorize(req(client)),client);
  assert.equal(policy.authorize(req('2001:0DB8:0:0:0:0:0:1')),'2001:db8::1');
  assert.equal(policy.authorize(req('127.0.0.1')),'127.0.0.1');
  denied(()=>policy.authorize(req(other)));
  denied(()=>policy.authorize(req('2001:db8::2')));
  denied(()=>policy.authorize(req('::1')));
});

test('equivalent IPv4 mapped addresses use one allowlist and rate-limit identity',()=>{
  for(const configured of [client,'::ffff:203.0.113.7','::FFFF:CB00:7107']) {
    const policy=createNetworkAccessPolicy({allowedClientIps:[configured]});
    for(const source of [client,'::ffff:203.0.113.7','0:0:0:0:0:ffff:cb00:7107']) {
      assert.equal(policy.authorize(req(source)),client);
    }
    denied(()=>policy.authorize(req('::203.0.113.7')));
    denied(()=>policy.authorize(req('2001:db8::cb00:7107')));
  }
});

test('direct mode never trusts forwarding headers to establish network access',()=>{
  const policy=createNetworkAccessPolicy({allowedClientIps:[client]});
  const forged={'x-bb-client-ip':client,'x-forwarded-for':client,'x-real-ip':client,
    forwarded:`for=${client}`,'x-azure-clientip':client};
  denied(()=>policy.authorize(req(other,forged)));
  assert.equal(policy.authorize(req(client,Object.fromEntries(Object.keys(forged).map(k=>[k,other])))),client);
});

test('missing or malformed socket evidence always denies without leaking input',()=>{
  const policy=createNetworkAccessPolicy({allowedClientIps:[client]});
  for(const input of [undefined,null,{},req(undefined),req(''),req(7),req({}),req(`${client}:443`),
    req('203.000.113.7'),req('fe80::1%eth0'),req('PRIVATE-SECRET'),req(`[${client}]`)]) {
    denied(()=>policy.authorize(input));
  }
});

test('proxy configuration pins exact peers and the one dedicated header',()=>{
  for(const proxy of [{},{peerIps:[]},{peerIps:[peer]},
    {peerIps:[peer],clientIpHeader:'x-forwarded-for'},
    {peerIps:[peer],clientIpHeader:'X-Bb-Client-Ip'},
    {peerIps:['192.0.2.0/24'],clientIpHeader:'x-bb-client-ip'},
    {peerIps:Array(65).fill(peer),clientIpHeader:'x-bb-client-ip'},
    {...config.trustedProxy,trustAll:true}]) {
    assert.throws(()=>createNetworkAccessPolicy({allowedClientIps:[client],trustedProxy:proxy}),TypeError);
  }
});

test('proxy mode requires a pinned peer and a separately allowed client',()=>{
  const policy=createNetworkAccessPolicy(config);
  assert.equal(policy.authorize(req(peer,{'x-bb-client-ip':client})),client);
  assert.equal(policy.authorize(req('::ffff:192.0.2.10',{'x-bb-client-ip':'::ffff:cb00:7107'})),client);
  denied(()=>policy.authorize(req(peer,{'x-bb-client-ip':other})));
  denied(()=>policy.authorize(req(other,{'x-bb-client-ip':client})));
  // An approved client connecting directly must not bypass the required proxy.
  denied(()=>policy.authorize(req(client,{'x-bb-client-ip':client})));
  denied(()=>policy.authorize(req(peer)));
});

test('proxy mode handles independent IPv6 peer and client addresses',()=>{
  const policy=createNetworkAccessPolicy({allowedClientIps:['2001:db8:2::5'],
    trustedProxy:{peerIps:['2001:db8:1::5'],clientIpHeader:'x-bb-client-ip'}});
  assert.equal(policy.authorize(req('2001:0DB8:1:0:0:0:0:5',{'x-bb-client-ip':'2001:0DB8:2:0:0:0:0:5'})),'2001:db8:2::5');
  denied(()=>policy.authorize(req('2001:db8:1::6',{'x-bb-client-ip':'2001:db8:2::5'})));
});

test('proxy header must be exactly one well-formed IP with matching transport evidence',()=>{
  const policy=createNetworkAccessPolicy(config);
  for(const value of ['',undefined,null,[client],`${client}, ${other}`,`${client} ${other}`,
    `for=${client}`,` ${client}`,`${client}\t`,`${client}:443`,'[2001:db8::1]',
    '203.000.113.7','::ffff:0.0.0.0','fe80::1%1']) {
    denied(()=>policy.authorize(req(peer,{'x-bb-client-ip':value})));
  }
  for(const mutate of [
    r=>{r.rawHeaders.push('X-Bb-Client-Ip',client);},
    r=>{r.rawHeaders=['X-Bb-Client-Ip',other];},
    r=>{r.rawHeaders=[];},r=>{delete r.rawHeaders;},r=>{r.rawHeaders=['x-bb-client-ip'];},
    r=>{r.rawHeaders={};},r=>{r.headers['X-Bb-Client-Ip']=client;},
    r=>{r.rawHeaders.push(7,'value');},r=>{r.rawHeaders.push('x-other',7);},
    r=>{r.rawHeaders.push(...Array.from({length:100},()=>['x-noise','x']).flat());},
  ]) {
    const r=req(peer,{'x-bb-client-ip':client});mutate(r);denied(()=>policy.authorize(r));
  }
  const capitalized=req(peer,{'x-bb-client-ip':client});capitalized.rawHeaders=['X-BB-CLIENT-IP',client];
  assert.equal(policy.authorize(capitalized),client);
});

test('ordinary forwarding headers cannot override the pinned proxy evidence',()=>{
  const policy=createNetworkAccessPolicy(config);
  const headers={'x-bb-client-ip':client,'x-forwarded-for':other,'x-real-ip':other,forwarded:`for=${other}`};
  assert.equal(policy.authorize(req(peer,headers)),client);
  delete headers['x-bb-client-ip'];denied(()=>policy.authorize(req(peer,headers)));
});

test('configuration is copied once and the resulting policy is immutable',()=>{
  const input={allowedClientIps:[client],trustedProxy:{peerIps:[peer],clientIpHeader:'x-bb-client-ip'}};
  const policy=createNetworkAccessPolicy(input);
  assert.equal(Object.isFrozen(policy),true);
  input.allowedClientIps.push(other);input.trustedProxy.peerIps.push(other);input.trustedProxy.clientIpHeader='x-forwarded-for';
  assert.equal(policy.authorize(req(peer,{'x-bb-client-ip':client})),client);
  denied(()=>policy.authorize(req(peer,{'x-bb-client-ip':other})));
  denied(()=>policy.authorize(req(other,{'x-bb-client-ip':client})));
  assert.throws(()=>{policy.authorize=()=>other;},TypeError);
});
