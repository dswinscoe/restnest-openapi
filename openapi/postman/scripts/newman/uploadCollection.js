const newman = require('newman');
const path = require('path');

const root = path.join(__dirname, '../..'); // postman root

function uploadCollection() {
  const collectionPath = path.join(root, 'collection/ServicePublish.postman_collection.json');
  const globalsPath = path.join(root, 'environment/restnest-postman.postman_globals.json');
  newman
    .run({
      bail: false,
      color: 'on',
      collection: require(collectionPath),
      globals: require(globalsPath),
      iterationCount: 1,
    })
    .on('done', function (err, summary) {
      if (err || summary.error) {
        console.error('Collection run encountered an error: ', err || summary.error);
      } else {
        console.log('Collection uploaded successfully.');
      }
    });
}

uploadCollection();
