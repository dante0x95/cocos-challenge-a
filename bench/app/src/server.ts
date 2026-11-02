// APP_MODE=naive levanta la línea base Z (src/naive); por defecto, la API de A (src/app).
const port = Number(process.env.PORT ?? 3000);
const mode = process.env.APP_MODE ?? 'a';
const { createApp } = mode === 'naive' ? await import('./naive/app.js').then((m) => ({ createApp: m.createNaiveApp })) : await import('./app.js');
createApp().listen(port, () => {
  console.log(`balances-api (${mode}) escuchando en :${port}`);
});
