// Check connection status from storage
function refreshStatus() {
  chrome.storage.local.get(['connected'], (result) => {
    const statusDiv = document.getElementById('status');
    if (result.connected) {
      statusDiv.className = 'status connected';
      statusDiv.innerHTML = 'Status: <b>Connected to AI</b>';
    } else {
      statusDiv.className = 'status disconnected';
      statusDiv.innerHTML = 'Status: <b>Waiting for MCP Server...</b>';
    }
  });
}

setInterval(refreshStatus, 1000);
refreshStatus();

document.getElementById('copyCmd').style.display = 'none'; // No longer needed
