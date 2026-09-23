const json=(data,status=200,extra={})=>new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json; charset=utf-8","access-control-allow-origin":"*","access-control-allow-headers":"Authorization, Content-Type, X-Admin-Password","access-control-allow-methods":"GET, POST, DELETE, OPTIONS",...extra}});
const now=()=>new Date().toISOString();
const id=()=>crypto.randomUUID();

function tursoUrl(env){
  const raw=String(env.TURSO_DATABASE_URL||"").trim();
  if(!raw) throw new Error("TURSO_DATABASE_URL is not configured");
  const url=raw.replace(/^libsql:\/\//,"https://").replace(/\/$/,"");
  return url.endsWith("/v2/pipeline")?url:url+"/v2/pipeline";
}

function tursoArg(value){
  if(value===null||value===undefined)return {type:"null"};
  if(typeof value==="number")return Number.isInteger(value)?{type:"integer",value:String(value)}:{type:"float",value};
  if(typeof value==="boolean")return {type:"integer",value:value?"1":"0"};
  return {type:"text",value:String(value)};
}

function decodeTursoValue(v){
  if(v===null||v===undefined)return null;
  if(typeof v==="object"&&"type" in v){
    if(v.type==="null")return null;
    return v.value;
  }
  return v;
}

function rowsToObjects(result){
  const cols=(result?.cols||[]).map(c=>typeof c==="string"?c:(c?.name||""));
  return (result?.rows||[]).map(row=>{
    const values=Array.isArray(row)?row:(row?.values||[]);
    const out={};
    cols.forEach((c,i)=>{out[c]=decodeTursoValue(values[i]);});
    return out;
  });
}

async function turso(env,sql,args=[]){
  const token=String(env.TURSO_AUTH_TOKEN||"").trim();
  if(!token)throw new Error("TURSO_AUTH_TOKEN is not configured");
  const response=await fetch(tursoUrl(env),{
    method:"POST",
    headers:{"content-type":"application/json","authorization":"Bearer "+token},
    body:JSON.stringify({requests:[{type:"execute",stmt:{sql,args:args.map(tursoArg)}},{type:"close"}]})
  });
  if(!response.ok)throw new Error("Turso request failed: "+response.status+" "+await response.text());
  const payload=await response.json();
  const first=payload?.results?.[0];
  if(first?.type==="error")throw new Error(first.error?.message||"Turso SQL error");
  return first?.response?.result||first?.result||{};
}

async function ensureSchema(env){
  await turso(env,`CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    key_hash TEXT NOT NULL UNIQUE,
    key_prefix TEXT NOT NULL,
    label TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    request_count INTEGER NOT NULL DEFAULT 0
  )`);
  await turso(env,`CREATE TABLE IF NOT EXISTS usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key_id TEXT NOT NULL,
    model TEXT NOT NULL,
    tokens_in INTEGER,
    tokens_out INTEGER,
    created_at TEXT NOT NULL,
    FOREIGN KEY(key_id) REFERENCES api_keys(id)
  )`);
  await turso(env,`CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash)`);
  await turso(env,`CREATE INDEX IF NOT EXISTS idx_usage_key_created ON usage(key_id, created_at)`);
}

async function tursoFirst(env,sql,args=[]){
  const result=await turso(env,sql,args);
  return rowsToObjects(result)[0]||null;
}

async function tursoAll(env,sql,args=[]){
  const result=await turso(env,sql,args);
  return rowsToObjects(result);
}

async function sha256(value){
  const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));
  return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("");
}

function randomKey(){
  const bytes=new Uint8Array(32); crypto.getRandomValues(bytes);
  return "nxa_"+btoa(String.fromCharCode(...bytes)).replace(/[^a-zA-Z0-9]/g,"").slice(0,43);
}

function adminOk(req,env){
  return !!env.NEXORA_ADMIN_PASSWORD && req.headers.get("X-Admin-Password")===env.NEXORA_ADMIN_PASSWORD;
}

async function requireKey(req,env){
  await ensureSchema(env);
  const auth=req.headers.get("Authorization")||"";
  const key=auth.startsWith("Bearer ")?auth.slice(7).trim():"";
  if(!key.startsWith("nxa_"))throw new Error("INVALID_API_KEY");
  const hash=await sha256(key);
  const row=await tursoFirst(env,"SELECT * FROM api_keys WHERE key_hash=? AND active=1",[hash]);
  if(!row)throw new Error("INVALID_API_KEY");
  await turso(env,"UPDATE api_keys SET last_used_at=?,request_count=request_count+1 WHERE id=?",[now(),row.id]);
  return row;
}

function corsPreflight(){
  return new Response(null,{status:204,headers:{"access-control-allow-origin":"*","access-control-allow-headers":"Authorization, Content-Type, X-Admin-Password","access-control-allow-methods":"GET, POST, DELETE, OPTIONS"}});
}

async function createKey(req,env){
  if(!adminOk(req,env))return json({error:{message:"Admin authentication required",type:"authentication_error"}},401);
  await ensureSchema(env);
  const body=await req.json().catch(()=>({}));
  const key=randomKey(),keyId=id(),created=now(),label=String(body.label||"Nexora API Key").slice(0,100);
  await turso(env,"INSERT INTO api_keys(id,key_hash,key_prefix,label,active,created_at) VALUES(?,?,?,?,1,?)",[keyId,await sha256(key),key.slice(0,12),label,created]);
  const origin=new URL(req.url).origin;
  return json({id:keyId,label,key,warning:"Store this key securely. It is shown only once.",model_url:origin+"/v1",chat_completions_url:origin+"/v1/chat/completions",models_url:origin+"/v1/models",model:env.NEXORA_MODEL_NAME||"nexora-coder"});
}

async function listKeys(req,env){
  if(!adminOk(req,env))return json({error:{message:"Admin authentication required"}},401);
  await ensureSchema(env);
  const results=await tursoAll(env,"SELECT id,key_prefix,label,active,created_at,last_used_at,request_count FROM api_keys ORDER BY created_at DESC");
  return json({data:results});
}

async function revoke(req,env,idValue){
  if(!adminOk(req,env))return json({error:{message:"Admin authentication required"}},401);
  await ensureSchema(env);
  await turso(env,"UPDATE api_keys SET active=0 WHERE id=?",[idValue]);
  return json({ok:true,id:idValue,active:false});
}

function apiInfo(req,env){
  const origin=new URL(req.url).origin;
  return {
    service:"Nexora API",
    status:"online",
    version:"1.0",
    model:env.NEXORA_MODEL_NAME||"nexora-coder",
    provider:"Cloudflare Workers AI",
    endpoints:{
      health:origin+"/health",
      models:origin+"/v1/models",
      chat_completions:origin+"/v1/chat/completions",
      admin:origin+"/admin"
    },
    authentication:"Bearer API key required for /v1/chat/completions"
  };
}

async function models(req,env){
  const origin=new URL(req.url).origin;
  return json({object:"list",data:[{id:env.NEXORA_MODEL_NAME||"nexora-coder",object:"model",created:0,owned_by:"nexora",permission:[],root:env.NEXORA_MODEL||"@cf/openai/gpt-oss-120b",endpoint:origin+"/v1/chat/completions"}]});
}

function normalizeMessages(messages){
  return messages.map((m)=>({
    role:String(m?.role||"user"),
    content:m?.content??null,
    ...(m?.name?{name:m.name}:{}),
    ...(m?.tool_call_id?{tool_call_id:m.tool_call_id}:{}),
    ...(Array.isArray(m?.tool_calls)?{tool_calls:m.tool_calls}: {})
  }));
}

async function chat(req,env){
  let keyRow;
  try{keyRow=await requireKey(req,env);}catch(e){return json({error:{message:"Invalid or revoked API key",type:"authentication_error",code:"invalid_api_key"}},401);}
  const body=await req.json().catch(()=>null);
  if(!body?.messages||!Array.isArray(body.messages)||body.messages.length===0)return json({error:{message:"messages must be a non-empty array",type:"invalid_request_error"}},400);

  const model=env.NEXORA_MODEL||"@cf/openai/gpt-oss-120b";
  const publicModel=env.NEXORA_MODEL_NAME||"nexora-coder";
  const input={
    messages:normalizeMessages(body.messages),
    temperature:body.temperature??0.15,
    max_tokens:body.max_tokens??8192
  };

  for(const key of ["top_p","top_k","seed","repetition_penalty","frequency_penalty","presence_penalty","response_format"]){
    if(body[key]!==undefined)input[key]=body[key];
  }
  if(body.tools)input.tools=body.tools;
  if(body.tool_choice)input.tool_choice=body.tool_choice;
  if(body.reasoning)input.reasoning=body.reasoning;

  try{
    const result=await env.AI.run(model,input);
    const generatedText=result?.response??result?.output_text??result?.text??"";
    const toolCalls=Array.isArray(result?.tool_calls)?result.tool_calls:[];
    const usage=result?.usage||{};
    const message={role:"assistant",content:typeof generatedText==="string"?generatedText:(generatedText==null?null:JSON.stringify(generatedText))};
    if(toolCalls.length)message.tool_calls=toolCalls;

    await turso(env,"INSERT INTO usage(key_id,model,tokens_in,tokens_out,created_at) VALUES(?,?,?,?,?)",[keyRow.id,model,usage.prompt_tokens??usage.input_tokens??null,usage.completion_tokens??usage.output_tokens??null,now()]);

    const completion={
      id:"chatcmpl_"+id(),
      object:"chat.completion",
      created:Math.floor(Date.now()/1000),
      model:publicModel,
      choices:[{index:0,message,finish_reason:toolCalls.length?"tool_calls":"stop"}],
      usage
    };

    if(body.stream===true){
      const encoder=new TextEncoder();
      const payloads=[
        {id:completion.id,object:"chat.completion.chunk",created:completion.created,model:publicModel,choices:[{index:0,delta:{role:"assistant"},finish_reason:null}]},
        ...(message.content?message.content.split(/(?<=\\s)|(?=\\s)/).filter(Boolean).map(part=>({id:completion.id,object:"chat.completion.chunk",created:completion.created,model:publicModel,choices:[{index:0,delta:{content:part},finish_reason:null}]})):[]),
        {id:completion.id,object:"chat.completion.chunk",created:completion.created,model:publicModel,choices:[{index:0,delta:{},finish_reason:toolCalls.length?"tool_calls":"stop"}]},
      ];
      const stream=new ReadableStream({
        start(controller){
          for(const item of payloads)controller.enqueue(encoder.encode("data: "+JSON.stringify(item)+"\\n\\n"));
          controller.enqueue(encoder.encode("data: [DONE]\\n\\n"));
          controller.close();
        }
      });
      return new Response(stream,{status:200,headers:{"content-type":"text/event-stream; charset=utf-8","cache-control":"no-cache","access-control-allow-origin":"*","access-control-allow-headers":"Authorization, Content-Type","access-control-allow-methods":"POST, OPTIONS"}});
    }

    return json(completion);
  }catch(e){
    return json({error:{message:"Model execution failed",type:"model_error",code:"model_execution_failed",detail:String(e?.message||e)}},502);
  }
}

function adminHtml(){
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nexora API Admin</title><style>body{font-family:Inter,system-ui;background:#0b0d12;color:#eee;max-width:900px;margin:auto;padding:28px}input,button{padding:12px;border-radius:10px;border:1px solid #333;background:#151923;color:#fff;margin:4px}button{cursor:pointer}section{background:#11151d;border:1px solid #262c38;border-radius:16px;padding:18px;margin:14px 0}code{word-break:break-all}</style></head><body><h1>Nexora API</h1><p>Master Admin</p><section><input id="p" type="password" placeholder="Admin password"><input id="l" placeholder="Key label"><button onclick="gen()">Generate API Key</button><pre id="out"></pre></section><section><button onclick="load()">Refresh keys</button><div id="keys"></div></section><script>
const p=()=>document.getElementById("p").value;
async function gen(){const r=await fetch("/admin/keys",{method:"POST",headers:{"X-Admin-Password":p(),"content-type":"application/json"},body:JSON.stringify({label:document.getElementById("l").value})});const j=await r.json();document.getElementById("out").textContent=JSON.stringify(j,null,2);if(j.key){document.getElementById("out").textContent+="\\n\\nCOPY THIS API KEY NOW — IT IS SHOWN ONLY ONCE.\\n\\nMODEL URL: "+j.model_url+"\\nCHAT URL: "+j.chat_completions_url+"\\nMODELS URL: "+j.models_url}load()}
async function load(){const r=await fetch("/admin/keys",{headers:{"X-Admin-Password":p()}});const j=await r.json();document.getElementById("keys").innerHTML=(j.data||[]).map(x=>"<p><b>"+x.label+"</b> — "+x.key_prefix+"… — "+(x.active?"active":"revoked")+" <button onclick='rev(\""+x.id+"\")'>Revoke</button></p>").join("")}
async function rev(id){await fetch("/admin/keys/"+id,{method:"DELETE",headers:{"X-Admin-Password":p()}});load()}
</script></body></html>`;
}

export default {async fetch(req,env){
  if(req.method==="OPTIONS")return corsPreflight();
  const u=new URL(req.url);
  try{
    if(u.pathname==="/"&&req.method==="GET")return json(apiInfo(req,env));
    if(u.pathname==="/v1"&&req.method==="GET")return json(apiInfo(req,env));
    if(u.pathname==="/admin"&&req.method==="GET")return new Response(adminHtml(),{headers:{"content-type":"text/html;charset=utf-8"}});
    if(u.pathname==="/admin/keys"&&req.method==="POST")return createKey(req,env);
    if(u.pathname==="/admin/keys"&&req.method==="GET")return listKeys(req,env);
    if(u.pathname.startsWith("/admin/keys/")&&req.method==="DELETE")return revoke(req,env,u.pathname.split("/").pop());
    if(u.pathname==="/v1/models"&&req.method==="GET")return models(req,env);
    if(u.pathname==="/v1/chat/completions"&&req.method==="POST")return chat(req,env);
    if(u.pathname==="/health"&&req.method==="GET"){
      const health={ok:true,service:"nexora-api",model:env.NEXORA_MODEL_NAME||"nexora-coder",provider:"cloudflare-workers-ai",database:"configured",ai_binding:!!env.AI};
      try{await turso(env,"SELECT 1");await ensureSchema(env);health.database="connected";}catch(e){health.ok=false;health.database="error";health.database_error=String(e?.message||e);}
      if(!env.AI)health.ok=false;
      return json(health,health.ok?200:503);
    }
    return json({error:{message:"Not found",type:"invalid_request_error",path:u.pathname}},404);
  }catch(e){
    return json({error:{message:"Internal server error",type:"server_error",detail:String(e?.message||e)}},500);
  }
}};
