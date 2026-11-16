// The artifacts viewer page (viewer.html of an Export Artifacts export). Reads the inline data,
// { exported, listed, artifacts: ArtifactView[] } (see artifactView in popup.js), and shows the home page.
// The grid, the tabs and the artifact pages come with the next steps; for now the heading and the count.
(function () {
  'use strict';

  function readData() {
    try {
      const data = JSON.parse(document.getElementById('data').textContent);
      return data && Array.isArray(data.artifacts) ? data : { artifacts: [] };
    } catch (e) {
      return { artifacts: [] };
    }
  }

  const data = readData();
  const n = data.artifacts.length;
  document.getElementById('count').textContent = `${n} ${n === 1 ? 'artifact' : 'artifacts'}`;
})();
