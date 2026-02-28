const express = require('express');
const path = require('path');
const app = require('./src/app');
const server = require('./src/server');

const port = process.env.PORT || 5001;

// Serve static files from the React frontend app
app.use(express.static(path.join(__dirname, '../client/dist')));

// Anything that doesn't match the above, send back index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/dist/index.html'));
});

