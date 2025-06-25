const list = document.getElementById('list');
const detail = document.getElementById('detail');
const pdfFrame = document.getElementById('pdf');
const meta = document.getElementById('meta');

const socket = new WebSocket(`ws://${location.host}`);

socket.addEventListener('message', ev => {
  const msg = JSON.parse(ev.data);
  if (msg.type === 'history') {
    msg.data.forEach(addRow);
  } else if (msg.type === 'update') {
    addRow(msg.data, true);
  }
});

function addRow(data, highlight) {
  const div = document.createElement('div');
  div.textContent = `${data.timestamp}: ${JSON.stringify(data.result)}`;
  if (highlight) div.classList.add('new');
  div.onclick = () => showDetail(data);
  list.prepend(div);
}

function showDetail(data) {
  pdfFrame.src = data.pdfUrl;
  meta.textContent = JSON.stringify(data, null, 2);
  detail.style.display = 'block';
}
