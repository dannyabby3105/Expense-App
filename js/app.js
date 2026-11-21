var CATS={Food:'--c-food',Transport:'--c-transport',Bills:'--c-bills',Shopping:'--c-shopping',Health:'--c-health',Other:'--c-other'};
var CODES={'₦':'NGN','$':'USD','€':'EUR','£':'GBP'};
var FALLBACK={NGN:1500,USD:1,EUR:0.92,GBP:0.79}; // approximate units per 1 USD, used until live rates load
var KEY='expense-tracker-v1',AUTH_KEY='et-auth',RATE_KEY='et-rates';
var API=location.protocol==='file:'?'http://localhost:3000/api':'/api';
var state={expenses:[],budgets:{},budgetCurs:{},currency:'₦',month:'',editing:null};
var rates={r:FALLBACK,live:false,at:0};
var auth=null,syncTimer=null,dirty=false,session=0,busy=false,statusTimer=null;
var $=function(id){return document.getElementById(id)};

/* ---------- helpers ---------- */
function esc(s){return String(s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function today(){var d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')}
function monthName(m){var p=m.split('-');return new Date(+p[0],+p[1]-1,1).toLocaleDateString(undefined,{month:'long',year:'numeric'})}
function fmt(n,sym){return sym+Number(n).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}
function money(n){return fmt(n,state.currency)}
function conv(a,from,to){return from===to?a:a/rates.r[CODES[from]]*rates.r[CODES[to]]}
function val(e){return conv(e.amount,e.cur,state.currency)}
function status(msg){$('status').textContent=msg;clearTimeout(statusTimer);statusTimer=setTimeout(function(){$('status').textContent=''},6000)}

/* ---------- data ---------- */
function normalize(d){
  d=d||{};var cur=CODES[d.currency]?d.currency:'₦',b=d.budgets||{},bc=d.budgetCurs||{},o={};
  Object.keys(b).forEach(function(k){o[k]=CODES[bc[k]]?bc[k]:cur});
  return{currency:cur,budgets:b,budgetCurs:o,expenses:(Array.isArray(d.expenses)?d.expenses:[]).map(function(e){
    return{id:e.id,desc:e.desc,amount:e.amount,date:e.date,cat:CATS[e.cat]?e.cat:'Other',cur:CODES[e.cur]?e.cur:cur}})};
}
function apply(d){var n=normalize(d);state.expenses=n.expenses;state.budgets=n.budgets;state.budgetCurs=n.budgetCurs;state.currency=n.currency}
function snapshot(){return{expenses:state.expenses,budgets:state.budgets,budgetCurs:state.budgetCurs,currency:state.currency}}
function store(){try{localStorage.setItem(KEY,JSON.stringify(snapshot()))}catch(e){}}
function save(){store();sync()}
function load(){try{var s=localStorage.getItem(KEY);if(s)apply(JSON.parse(s))}catch(e){}}
function pickMonth(){
  var cur=today().slice(0,7),ms=state.expenses.map(function(e){return e.date.slice(0,7)}).sort();
  state.month=(!ms.length||ms.indexOf(cur)>=0)?cur:ms[ms.length-1];
}
function loadRates(){
  try{var c=JSON.parse(localStorage.getItem(RATE_KEY));if(c&&c.r&&c.r.USD){rates={r:c.r,live:true,at:c.at};if(Date.now()-c.at<432e5)return}}catch(e){}
  fetch('https://open.er-api.com/v6/latest/USD').then(function(r){return r.json()}).then(function(d){
    var r={};Object.keys(CODES).forEach(function(s){r[CODES[s]]=d.rates&&d.rates[CODES[s]]});
    if(Object.keys(r).some(function(k){return !(r[k]>0)}))return;
    rates={r:r,live:true,at:Date.now()};
    try{localStorage.setItem(RATE_KEY,JSON.stringify({r:r,at:rates.at}))}catch(e){}
    render();
  }).catch(function(){});
}

/* ---------- accounts and sync ---------- */
function api(path,method,body){
  var h={'Content-Type':'application/json'};if(auth)h.Authorization='Bearer '+auth.token;
  return fetch(API+path,{method:method||'GET',headers:h,body:body?JSON.stringify(body):undefined}).then(function(r){
    return r.json().then(function(d){if(!r.ok)throw new Error(d.error||'Request failed');return d})});
}
function sync(){
  if(!auth)return;dirty=true;clearTimeout(syncTimer);var s=session;
  syncTimer=setTimeout(function(){
    api('/data','PUT',snapshot()).then(function(){if(s===session)dirty=false}).catch(function(e){if(/session/i.test(e.message))finishSignOut()});
  },400);
}
// login=true: first load after signing in. Otherwise a quiet refresh that leaves the form and month alone.
function pull(login){
  var s=session;
  return api('/data').then(function(d){
    if(s!==session||dirty)return 0;
    var n=normalize(d),empty=!n.expenses.length&&!Object.keys(n.budgets).length;
    if(login){
      if(empty)sync();else{apply(d);store()}
      pickMonth();$('filter').value='All';resetForm();
    }else{
      if(state.editing)return 0;
      var before=JSON.stringify(snapshot());apply(d);
      if(JSON.stringify(snapshot())===before)return 0;
      store();
    }
    render();return state.expenses.length;
  }).catch(function(e){if(/session/i.test(e.message))finishSignOut();else if(login)status('Couldn’t reach the server. Showing the data saved on this device.');return 0});
}
function authGo(mode){
  if(busy)return;busy=true;$('aErr').textContent='';
  api('/'+mode,'POST',{email:$('aEmail').value.trim(),password:$('aPass').value}).then(function(d){
    session++;auth={token:d.token,email:d.email};
    try{localStorage.setItem(AUTH_KEY,JSON.stringify(auth))}catch(e){}
    $('aPass').value='';$('authDlg').close();
    return pull(true);
  }).then(function(n){
    status(mode==='register'?'Account created and signed in.':'Signed in. '+n+' expense'+(n===1?'':'s')+' loaded.');
  }).catch(function(e){
    $('aErr').textContent=e instanceof TypeError?'Can’t reach the server. Run npm start in the project folder.':e.message;
  }).then(function(){busy=false});
}
function signOut(){ // save the latest changes to the account first, then clear this device
  if(!auth)return;clearTimeout(syncTimer);
  api('/data','PUT',snapshot()).then(finishSignOut,function(e){
    if(/session/i.test(e.message)||confirm('Your latest changes could not be saved to your account. Sign out anyway?'))finishSignOut();
  });
}
function finishSignOut(){
  session++;clearTimeout(syncTimer);dirty=false;auth=null;
  try{localStorage.removeItem(AUTH_KEY);localStorage.removeItem(KEY)}catch(e){}
  state.expenses=[];state.budgets={};state.budgetCurs={};state.currency='₦';
  pickMonth();$('filter').value='All';resetForm();
  $('aEmail').value='';$('aPass').value='';$('aErr').textContent='';
  if($('authDlg').open)$('authDlg').close();
  render();status('Signed out. Your data is saved in your account and was cleared from this device.');
}

/* ---------- rendering ---------- */
function fillMonths(){
  var set={};set[today().slice(0,7)]=1;
  state.expenses.forEach(function(e){set[e.date.slice(0,7)]=1});
  if(state.month)set[state.month]=1;
  var months=Object.keys(set).sort().reverse();
  if(!state.month)state.month=months[0];
  $('month').innerHTML=months.map(function(m){return '<option value="'+m+'"'+(m===state.month?' selected':'')+'>'+monthName(m)+'</option>'}).join('');
}
function render(){
  fillMonths();
  $('currency').value=state.currency;
  $('authBtn').textContent=auth?'Sign out':'Sign in';
  $('who').textContent=auth?auth.email:'';$('who').hidden=!auth;
  var mixed=state.expenses.some(function(e){return e.cur!==state.currency})||Object.keys(state.budgetCurs).some(function(k){return state.budgetCurs[k]!==state.currency});
  $('rateNote').textContent=!mixed?'':rates.live?'Amounts in other currencies are converted at live rates from '+new Date(rates.at).toLocaleDateString()+'.':'Amounts in other currencies use approximate rates because live rates could not be loaded.';
  renderTrend();

  var inMonth=state.expenses.filter(function(e){return e.date.slice(0,7)===state.month});
  var total=inMonth.reduce(function(a,e){return a+val(e)},0);
  $('total').textContent=money(total);
  $('monthLabel').textContent='Spent in '+monthName(state.month);
  var by={};Object.keys(CATS).forEach(function(c){by[c]=0});
  inMonth.forEach(function(e){by[e.cat]+=val(e)});
  var used=Object.keys(by).filter(function(c){return by[c]>0});
  $('split').innerHTML=used.map(function(c){return '<span style="width:'+(by[c]/total*100)+'%;background:var('+CATS[c]+')"></span>'}).join('');
  $('legend').innerHTML=used.map(function(c){return '<span><i style="background:var('+CATS[c]+')"></i>'+c+' <b>'+money(by[c])+'</b></span>'}).join('')||'Nothing logged yet for this month.';

  var b=Number(state.budgets[state.month])||0,bd=b?conv(b,state.budgetCurs[state.month]||state.currency,state.currency):0;
  $('budgetInput').value=bd?Math.round(bd*100)/100:'';
  if(bd>0){
    $('fill').style.width=Math.min(100,total/bd*100)+'%';
    $('budget').classList.toggle('over',total>bd);
    $('budgetMsg').textContent=total>bd?('Over budget by '+money(total-bd)+'. '):(money(bd-total)+' left. ');
  }else{$('fill').style.width='0';$('budget').classList.remove('over');$('budgetMsg').textContent=''}

  var f=$('filter').value||'All';
  var shown=inMonth.filter(function(e){return f==='All'||e.cat===f}).sort(function(a,b){return b.date.localeCompare(a.date)||b.id-a.id});
  $('list').innerHTML=shown.length?shown.map(function(e){
    return '<li><span class="dot" style="background:var('+CATS[e.cat]+')"></span>'+
      '<span class="d">'+esc(e.desc)+'<small>'+e.cat+' · '+new Date(e.date+'T00:00').toLocaleDateString(undefined,{day:'numeric',month:'short'})+(e.cur!==state.currency?' · entered as '+fmt(e.amount,e.cur):'')+'</small></span>'+
      '<span class="amt">'+money(val(e))+'</span>'+
      '<span class="acts"><button class="x" data-edit="'+e.id+'" aria-label="Edit '+esc(e.desc)+'">✎</button><button class="x" data-id="'+e.id+'" aria-label="Delete '+esc(e.desc)+'">×</button></span></li>'}).join(''):
    '<li class="empty" style="display:block">No expenses here yet. Add one to get started.</li>';
}
function renderTrend(){
  var p=state.month.split('-'),y=+p[0],m=+p[1]-1,items=[];
  for(var i=5;i>=0;i--){
    var d=new Date(y,m-i,1),k=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');
    var t=state.expenses.reduce(function(a,e){return e.date.slice(0,7)===k?a+val(e):a},0);
    items.push({k:k,t:t,l:d.toLocaleDateString(undefined,{month:'short'})});
  }
  var max=Math.max.apply(null,items.map(function(x){return x.t}))||1;
  $('trend').innerHTML=items.map(function(x){
    return '<button class="m'+(x.k===state.month?' on':'')+'" data-m="'+x.k+'" aria-label="'+monthName(x.k)+': '+money(x.t)+'"><b>'+(x.t?state.currency+x.t.toLocaleString(undefined,{notation:'compact',maximumFractionDigits:1}):'')+'</b><span class="col" style="height:'+(x.t/max*100)+'%"></span><em>'+x.l+'</em></button>'}).join('');
}

/* ---------- form ---------- */
function resetForm(){
  state.editing=null;$('desc').value='';$('amount').value='';$('date').value=today();$('fcur').value=state.currency;
  $('formTitle').textContent='Add expense';$('add').textContent='Add expense';$('cancel').hidden=true;$('err').textContent='';
}
function startEdit(id){
  var e=state.expenses.find(function(x){return String(x.id)===id});if(!e)return;
  state.editing=e.id;$('desc').value=e.desc;$('amount').value=e.amount;$('date').value=e.date;$('cat').value=e.cat;$('fcur').value=e.cur;
  $('formTitle').textContent='Edit expense';$('add').textContent='Save changes';$('cancel').hidden=false;$('err').textContent='';
  $('desc').focus();
}
function init(){
  try{auth=JSON.parse(localStorage.getItem(AUTH_KEY))}catch(e){}
  if(!auth||!auth.token)auth=null;
  load();loadRates();
  var co=Object.keys(CODES).map(function(s){return '<option value="'+s+'">'+s+' '+CODES[s]+'</option>'}).join('');
  $('currency').innerHTML=co;$('fcur').innerHTML=co;
  var opts=Object.keys(CATS).map(function(c){return '<option>'+c+'</option>'}).join('');
  $('cat').innerHTML=opts;$('filter').innerHTML='<option>All</option>'+opts;
  pickMonth();resetForm();render();
}

/* ---------- events ---------- */
$('add').onclick=function(){
  var desc=$('desc').value.trim(),amt=parseFloat($('amount').value),date=$('date').value;
  if(!desc){$('err').textContent='Enter a description.';return}
  if(!(amt>0)){$('err').textContent='Enter an amount greater than 0.';return}
  if(!date){$('err').textContent='Pick a date.';return}
  if(state.editing){
    var e=state.expenses.find(function(x){return x.id===state.editing});
    if(e){e.desc=desc;e.amount=amt;e.cat=$('cat').value;e.date=date;e.cur=$('fcur').value}
  }else state.expenses.push({id:Date.now(),desc:desc,amount:amt,cat:$('cat').value,date:date,cur:$('fcur').value});
  state.month=date.slice(0,7);
  save();resetForm();$('desc').focus();render();
};
$('cancel').onclick=resetForm;
$('list').onclick=function(ev){
  var b=ev.target.closest('button');if(!b)return;
  var ed=b.getAttribute('data-edit'),id=b.getAttribute('data-id');
  if(ed){startEdit(ed);return}
  if(id){
    state.expenses=state.expenses.filter(function(e){return String(e.id)!==id});
    if(String(state.editing)===id)resetForm();
    save();render();
  }
};
$('trend').onclick=function(ev){var b=ev.target.closest('[data-m]');if(b){state.month=b.getAttribute('data-m');render()}};
$('month').onchange=function(){state.month=this.value;render()};
$('filter').onchange=render;
$('currency').onchange=function(){state.currency=this.value;if(!state.editing)$('fcur').value=this.value;save();render()};
$('budgetInput').onchange=function(){
  var v=parseFloat(this.value);
  if(v>0){state.budgets[state.month]=v;state.budgetCurs[state.month]=state.currency}
  else{delete state.budgets[state.month];delete state.budgetCurs[state.month]}
  save();render();
};
$('export').onclick=function(){
  var safe=function(s){s=String(s);return /^[=+\-@]/.test(s)?"'"+s:s};
  var rows=[['Date','Description','Category','Amount','Currency']].concat(state.expenses.slice().sort(function(a,b){return a.date.localeCompare(b.date)}).map(function(e){return [e.date,safe(e.desc),e.cat,e.amount,CODES[e.cur]]}));
  var csv=rows.map(function(r){return r.map(function(c){return '"'+String(c).replace(/"/g,'""')+'"'}).join(',')}).join('\r\n');
  var a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'}));
  a.download='expenses.csv';document.body.appendChild(a);a.click();a.remove();
};
$('authBtn').onclick=function(){if(auth)signOut();else{$('aErr').textContent='';$('authDlg').showModal()}};
$('aLogin').onclick=function(){authGo('login')};
$('aSignup').onclick=function(){authGo('register')};
$('aClose').onclick=function(){$('authDlg').close()};
$('aPass').addEventListener('keydown',function(e){if(e.key==='Enter')authGo('login')});
['desc','amount'].forEach(function(id){$(id).addEventListener('keydown',function(e){if(e.key==='Enter')$('add').click()})});
document.addEventListener('visibilitychange',function(){if(!document.hidden&&auth&&!dirty)pull(false)});

init();
if(auth)pull(false);
