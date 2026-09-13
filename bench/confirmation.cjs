// Exercise a real native confirmation or a visible HTML confirmation.
// Never call application callbacks directly.
exports.confirmAction = async function(page, frame, trigger, accept) {
  let nativeResolve, dialogAction;
  const native = new Promise(resolve => { nativeResolve=resolve; });
  const handler = dialog => {
    dialogAction = accept ? dialog.accept() : dialog.dismiss();
    nativeResolve('native');
  };
  page.on('dialog',handler);
  try {
    await trigger.click();
    const cancel=frame.getByRole('button',{name:/^(cancel|no\b|keep\b)/i}).first();
    let kind;
    try {
      kind=await Promise.race([native,cancel.waitFor({state:'visible',timeout:4000}).then(()=>'html')]);
    } catch {
      throw Error('New World did not open a native confirmation or an HTML confirmation with a Cancel/No button');
    }
    if(kind==='native'){await dialogAction;return;}
    if(!accept){await cancel.click();return;}
    // Find the nearest group containing both the cancel and confirm controls.
    let group=cancel.locator('..');
    for(let i=0;i<5;i++,group=group.locator('..')){
      const yes=group.getByRole('button',{name:/^(yes\b|confirm\b|create\b|new world\b|reset\b)/i}).first();
      if(await yes.isVisible()){await yes.click();return;}
    }
    throw Error('HTML confirmation has no visible Yes/Confirm/Create/New World button');
  } finally {
    page.off('dialog',handler);
  }
};
