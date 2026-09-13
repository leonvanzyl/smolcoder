// Keep actionable browser failures, including errors caught by application code.
function observeErrors(page) {
  const errors=[],consoleErrors=[];
  const remember=(list,text)=>{
    text=String(text).slice(0,1200);
    if(!list.includes(text)){list.push(text);if(list.length>12)list.shift();}
  };
  page.on('pageerror',error=>remember(errors,error.message));
  page.on('console',message=>{if(message.type()==='error')remember(consoleErrors,message.text());});
  return {errors,consoleErrors};
}
module.exports={observeErrors};
