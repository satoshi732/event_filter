import { initListPage } from './listPage.js';
import { initDetailPage } from './detailPage.js';

const page = document.body.dataset.page || 'list';
const init = page === 'detail' ? initDetailPage : initListPage;

init().catch((error) => {
  const target =
    document.querySelector('#runMeta') ||
    document.querySelector('#detailRunMeta') ||
    document.querySelector('#detailMeta');
  if (target) target.textContent = error.message;
});
