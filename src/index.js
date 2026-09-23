const json=(data,status=200,extra={})=>new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json; charset=utf-8","access-control-allow-origin":"*","access-control-allow-headers":"Authorization, Content-Type, X-Admin-Password","access-control-allow-methods":"GET, POST, DELETE, OPTIONS",...extra}});
const now=()=>new Date().toISOString();
const id=()=>crypto.randomUUID();

async function sha256(value){
  const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));
  return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("");
}
function randomKey(){
  const bytes=new Uint8Array(32); crypto.getRandomValues(bytes);
  return "nxa_"+btoa(String.fromCharCode(...bytes)).replace(/[^a-zA-Z0-9]/g,"").slice(0,43);
}
function adminOk(req,env){return !!env.NEXORA_ADMIN_PASSWORD && req.headers.get("X-Admin-Password")===env.NEXORA_ADMIN_PASSWORD;}
async function requireKey(req,env){
  const auth=req.headers.get("Authorization")||"";
  const key=auth.startsWith("Bearer ")?auth.slice(7).trim():"";
  if(!key.startsWith("nxa_")) throw new Error("INVALID_API_KEY");
  const hash=await sha256(key);
  const row=await env.DB.prepare("SELECT * FROM api_keys WHERE key_hash=? AND active=1").bind(hash).first();
  if(!row) throw new Error("INVALID_API_KEY");
  await env.DB.prepare("UPDATE api_keys SET last_used_at=?,request_count=request_count+1 WHERE id=?").bind(now(),row.id).run();
  return row;
}
function corsPreflight(){return new Response(null,{status:204,headers:{"access-control-allow-origin":"*","access-control-allow-headers":"Authorization, Content-Type, X-Admin-Password","access-control-allow-methods":"GET, POST, DELETE, OPTIONS"}});}

async function createKey(req,env){
  if(!adminOk(req,env)) return json({error:{message:"Admin authentication required",type:"authentication_error"}},401);
  const body=await req.json().catch(()=>({}));
  const key=randomKey(), keyId=id(), created=now(), label=String(body.label||"Nexora API Key").slice(0,100);
  await env.DB.prepare("INSERT INTO api_keys(id,key_hash,key_prefix,label,active,created_at) VALUES(?,?,?,?,1,?)")
    .bind(keyId,await sha256(key),key.slice(0,12),label,created).run();
  const origin=new URL(req.url).origin;
  return json({id:keyId,label,key,warning:"Store this key securely. It is shown only once.",model_url:origin+"/v1",chat_completions_url:origin+"/v1/chat/completions",models_url:origin+"/v1/models",model:env.NEXORA_MODEL_NAME||"nexora-coder"});
}
async function listKeys(req,env){
  if(!adminOk(req,env)) return json({error:{message:"Admin authentication required"}},401);
  const r=await env.DB.prepare("SELECT id,key_prefix,label,active,created_at,last_used_at,request_count FROM api_keys ORDER BY created_at DESC").all();
  return json({data:r.results||[]});
}
async function revoke(req,env,idValue){
  if(!adminOk(req,env)) return json({error:{message:"Admin authentication required"}},401);
  await env.DB.prepare("UPDATE api_keys SET active=0 WHERE id=?").bind(idValue).run();
  return json({ok:true,id:idValue,active:false});
}
async function models(req,env){
  const origin=new URL(req.url).origin;
  return json({object:"list",data:[{id:env.NEXORA_MODEL_NAME||"nexora-coder",object:"model",owned_by:"nexora",endpoint:origin+"/v1/chat/completions"}]});
}
async function chat(req,env){
  let keyRow;
  try{keyRow=await requireKey(req,env);}catch(e){return json({error:{message:"Invalid or revoked API key",type:"authentication_error"}},401);}
  const body=await req.json().catch(()=>null);
  if(!body?.messages || !Array.isArray(body.messages)) return json({error:{message:"messages must be an array",type:"invalid_request_error"}},400);
  const model=body.model||env.NEXORA_MODEL||"@cf/openai/gpt-oss-120b";
  const input={messages:body.messages,temperature:body.temperature??0.15,max_tokens:body.max_tokens??8192};
  if(body.tools) input.tools=body.tools;
  if(body.tool_choice) input.tool_choice=body.tool_choice;
  try{
    const result=await env.AI.run(model,input);
    const text=result?.response ?? result?.output_text ?? result?.text ?? "";
    const usage=result?.usage||{};
    await env.DB.prepare("INSERT INTO usage(key_id,model,tokens_in,tokens_out,created_at) VALUES(?,?,?,?,?)")
      .bind(keyRow.id,model,usage.prompt_tokens??usage.input_tokens??null,usage.completion_tokens??usage.output_tokens??null,now()).run();
    return json({id:"chatcmpl_"+id(),object:"chat.completion",created:Math.floor(Date.now()/1000),model:env.NEXORA_MODEL_NAME||"nexora-coder",choices:[{index:0,message:{role:"assistant",content:typeof text==="string"?text:JSON.stringify(text)},finish_reason:"stop"}],usage});
  }catch(e){
    return json({error:{message:"Model execution failed",type:"model_error",detail:String(e.message||e)}},502);
  }
}
function adminHtml(origin){return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nexora API Admin</title><style>body{font-family:Inter,system-ui;background:#0b0d12;color:#eee;max-width:900px;margin:auto;padding:28px}input,button{padding:12px;border-radius:10px;border:1px solid #333;background:#151923;color:#fff;margin:4px}button{cursor:pointer}section{background:#11151d;border:1px solid #262c38;border-radius:16px;padding:18px;margin:14px 0}code{word-break:break-all}</style></head><body><h1>Nexora API</h1><p>Master Admin</p><section><input id="p" type="password" placeholder="Admin password"><input id="l" placeholder="Key label"><button onclick="gen()">Generate API Key</button><pre id="out"></pre></section><section><button onclick="load()">Refresh keys</button><div id="keys"></div></section><script>
const p=()=>document.getElementById("p").value;
async function gen(){const r=await fetch("/admin/keys",{method:"POST",headers:{"X-Admin-Password":p(),"content-type":"application/json"},body:JSON.stringify({label:document.getElementById("l").value})});document.getElementById("out").textContent=JSON.stringify(await r.json(),null,2);load()}
async function load(){const r=await fetch("/admin/keys",{headers:{"X-Admin-Password":p()}});const j=await r.json();document.getElementById("keys").innerHTML=(j.data||[]).map(x=>"<p><b>"+x.label+"</b> — "+x.key_prefix+"… — "+(x.active?"active":"revoked")+" <button onclick='rev(\""+x.id+"\")'>Revoke</button></p>").join("")}
async function rev(id){await fetch("/admin/keys/"+id,{method:"DELETE",headers:{"X-Admin-Password":p()}});load()}
</script></body></html>`}
export default {async fetch(req,env){
  if(req.method==="OPTIONS")return corsPreflight();
  const u=new URL(req.url);
  try{
    if(u.pathname==="/admin"&&req.method==="GET")return new Response(adminHtml(u.origin),{headers:{"content-type":"text/html;charset=utf-8"}});
    if(u.pathname==="/admin/keys"&&req.method==="POST")return createKey(req,env);
    if(u.pathname==="/admin/keys"&&req.method==="GET")return listKeys(req,env);
    if(u.pathname.startsWith("/admin/keys/")&&req.method==="DELETE")return revoke(req,env,u.pathname.split("/").pop());
    if(u.pathname==="/v1/models"&&req.method==="GET")return models(req,env);
    if(u.pathname==="/v1/chat/completions"&&req.method==="POST")return chat(req,env);
    if(u.pathname==="/health")return json({ok:true,service:"nexora-api",model:env.NEXORA_MODEL_NAME||"nexora-coder"});
    return json({error:{message:"Not found"}},404);
  }catch(e){return json({error:{message:"Internal server error",detail:String(e.message||e)}},500)}
}};
