const localPort = 3030;
const appPort = 1998;
const scriptPath = process.cwd() + "\\server.js";

const electron = require("electron");
const localShortcut = require("electron-localshortcut");
const { app, BrowserWindow, screen, ipcMain, dialog, shell, Menu, globalShortcut } = electron;

const express = require("express");
const localExpress = express();
const appExpress = express();
const localServer = localExpress.listen(localPort, "localhost");
const appServer = appExpress.listen(appPort);

const ip = require("ip");
const os = require("os");
const fs = require("fs");
const path = require("path");
const mime = require("mime-types");
const glob = require("glob");
const metadata = require("music-metadata");
const body_parser = require("body-parser");

const dataDirectory = path.join(app.getPath("userData"), "X-Music/");
const settingsFile = dataDirectory + "settings.json";
const playlistsFile = dataDirectory + "playlists.json";

let defaultSettings = JSON.stringify({
	libraryDirectory:"",
	loop:"none",
	volume:100,
	allowRemote:true
});

// Create the directory and files used to store the user's playlists and settings.
if(!fs.existsSync(dataDirectory)) {
	fs.mkdirSync(dataDirectory);
}
if(!fs.existsSync(settingsFile)) {
	fs.writeFileSync(settingsFile, defaultSettings);
}
if(!fs.existsSync(playlistsFile)) {
	fs.writeFileSync(playlistsFile, "");
}

app.requestSingleInstanceLock();
app.name = "KPlayer";

app.on("ready", function() {
	if(fs.existsSync(settingsFile) && fs.existsSync(playlistsFile)) {
		// Used to determine whether or not the remote's list of songs or playlists need to be updated.
		let refreshRemoteSongs = true;
		let refreshRemotePlaylists = true;

		// Used to determine the current status of the host app (what page is being viewed, what song is being played, and so on).
		let currentStatus = "";

		let settings = fs.readFileSync(settingsFile, { encoding:"utf-8" });
		let playlists = fs.readFileSync(playlistsFile, { encoding:"utf-8" });

		const { screenWidth, screenHeight } = screen.getPrimaryDisplay().workAreaSize;

		let windowWidth = 1280;
		let windowHeight = 720;

		if(screenWidth <= 1080 || screenHeight <= 620) {
			windowWidth = screenWidth - 100;
			windowHeight = screenHeight - 100;
		}

		const localWindow = new BrowserWindow({
			width:windowWidth,
			minWidth:1000,
			height:windowHeight,
			minHeight:550,
			resizable:true,
			frame:false,
			transparent:false,
			x:80,
			y:80,
			webPreferences: {
				nodeIntegration:true
			}
		});

		// macOS apps behave differently that Windows when it comes to closing an application.
		if(process.platform === "darwin") {
			let quit = true;

			localShortcut.register(localWindow,"Command+Q", () => {
				quit = true;
				app.quit();
			});
			
			localShortcut.register(localWindow,"Command+W", () => {
				quit = false;
				app.hide();
			});

			localWindow.on("close", (e) => {
				if(!quit) {
					e.preventDefault();
					quit = true;
				}
			});
		}

		localExpress.set("views", path.join(__dirname, "views"));
		localExpress.set("view engine", "ejs");
		localExpress.use("/assets", express.static(path.join(__dirname, "assets")));
		localExpress.use(body_parser.urlencoded({ extended:true }));
		localExpress.use(body_parser.json({ limit:"512mb" }));
		
		localWindow.loadURL("http://127.0.0.1:" + localPort);

		localExpress.get("/", (req, res) => {
			res.render("index");
		});

		ipcMain.on("getInfo", (error, req) => {
			sendInfo(false);
		});

		ipcMain.on("getSongs", (error, req) => {
			if(validJSON(settings)) {
				let libraryDirectory = JSON.parse(settings).libraryDirectory;
				if(libraryDirectory !== "") {
					// Watch the library directory for any file changes so new songs can be added without an actual manual refresh.
					let watch = fs.watch(libraryDirectory, { recursive:true, persistent:true }, () => {
						sendInfo(true);
						localWindow.webContents.send("notify", { title:"Refreshing", description:"Your music library is being updated.", color:"rgb(40,40,40)", duration:5000});
						refreshRemoteSongs = true;
					});

					// Get all files with the extensions .mp3, .wav, and .ogg.
					glob(libraryDirectory + "/**/*.{mp3, wav, ogg}", (error, files) => {
						if(error) {
							console.log(error);
							localWindow.webContents.send("notify", { title:"Error", description:"Couldn't fetch songs.", color:"rgb(40,40,40)", duration:5000 });
						}
						else {
							let songs = [];
							let count = 0;
							files.map(file => {
								metadata.parseFile(file).then(data => {
									let title = data.common.title;
									let artist = data.common.artist;
									let album = data.common.album;
									let duration = data.format.duration;

									// To avoid empty fields, if the file doesn't have the appropriate metadata, the file's name is used as the title, and the album and artist are set to "Unknown".
									if(typeof data.common.title === "undefined" || data.common.title.trim() === "") {
										title = path.basename(file).split(".").slice(0, -1).join(".");
									}
									if(typeof data.common.album === "undefined" || data.common.album.trim() === "") {
										album = "Unknown Album";
									}
									if(typeof data.common.artist === "undefined" || data.common.artist.trim() === "") {
										artist = "Unknown Artist";
									}

									songs.push({ file:file, title:title, artist:artist, album:album, duration:duration });

									count++;
									if(count === files.length) {
										localWindow.webContents.send("getSongs", songs);
									}
								}).catch(error => {
									console.log(error);
									localWindow.webContents.send("notify", { title:"Error", description:"Couldn't parse the metadata.", color:"rgb(40,40,40)", duration:5000 });
								});
							});
						}
					});
				}
				else {
					localWindow.webContents.send("getSongs", "");
				}
			}
		});

		ipcMain.on("playSong", (error, req) => {
			let type = mime.lookup(req).toLowerCase();
			if(type === "audio/mpeg" || type === "audio/x-wav" || type === "audio/ogg" || type === "application/ogg") {
				fs.readFile(req, function(error, file) {
					let base64 = Buffer.from(file).toString("base64");
					localWindow.webContents.send("playSong", { base64:base64, mime:type });
					if(error) {
						localWindow.webContents.send("notify", { title:"Error", description:"Couldn't read the audio file.", color:"rgb(40,40,40)", duration:5000 });
					}
				});
			}
			else {
				localWindow.webContents.send("notify", { title:"Error", description:"Invalid file type.", color:"rgb(40,40,40)", duration:5000})
			}
		});

		ipcMain.on("setStatus", (error, req) => {
			currentStatus = JSON.stringify(req);
		});

		// Used to allow the user to browse their file system and choose a library directory.
		ipcMain.on("browseFiles",(error, req) => {
			let directory = dialog.showOpenDialogSync(localWindow, { title:"Select Music Library Directory", message:"Select the directory that contains your MP3, WAV, or OGG files.", properties:["openDirectory"] });
			if(typeof directory !== "undefined") {
				changeSettings("libraryDirectory", directory[0]);
			}
			else {
				localWindow.webContents.send("notify", { title:"Error", description:"Invalid library directory.", color:"rgb(40,40,40)", duration:5000 });
			}
		});

		ipcMain.on("loopSetting", (error, req) => {
			if(["none", "list", "song"].includes(req)) {
				changeSettings("loop", req);
			}
		});

		ipcMain.on("allowRemote", (error, req) => {
			if(typeof req === "boolean") {
				changeSettings("allowRemote", req);
			}
			else {
				localWindow.webContents.send("notify", { title:"Error", description:"Boolean data type only.", color:"rgb(40,40,40)", duration:5000 });
			}
		});

		ipcMain.on("setVolume", (error, req) => {
			try {
				let volume = parseInt(req);
				if(volume >= 0 && volume <= 100) {
					changeSettings("volume", volume);
				}
			}
			catch(e) {
				console.log(e);
				localWindow.webContents.send("notify", { title:"Error", description:"Volume value wasn't an integer.", color:"rgb(40,40,40)", duration:5000 });
			}
		});

		ipcMain.on("addPlaylist", (error, req) => {
			if(typeof req !== "undefined" && req.toString().trim() !== "") {
				let name = req.toString().trim();
				if(validJSON(playlists) || playlists.toString().trim() === "") {
					let currentPlaylists = {};

					if(playlists.toString().trim() !== "") {
						currentPlaylists = JSON.parse(playlists.toString());
					}

					if(name in currentPlaylists) {
						localWindow.webContents.send("notify", { title:"Error", description:"A playlist with that name already exists.", color:"rgb(40,40,40)", duration:5000 });
					}
					else {
						currentPlaylists[name] = { songs:[] };
						fs.writeFile(playlistsFile, JSON.stringify(currentPlaylists), (error) => {
							if(error) {
								console.log(error);
								localWindow.webContents.send("notify", { title:"Error", description:"Could not write to playlists file.", color:"rgb(40,40,40)", duration:5000 });
							}
							else {
								playlists = JSON.stringify(currentPlaylists);
								sendInfo(false);
								localWindow.webContents.send("notify", { title:"Playlist Created", description:"The playlist has been created.", color:"rgb(40,40,40)", duration:5000 });
								refreshRemoteSongs = true;
								refreshRemotePlaylists = true;
							}
						});
					}
				}
			}
			else {
				localWindow.webContents.send("notify", { title:"Error", description:"Invalid playlist name.", color:"rgb(40,40,40)", duration:5000 });
			}
		});

		ipcMain.on("removePlaylist", (error, req) => {
			if(typeof req !== "undefined" && req.toString().trim() !== "") {
				let name = req.toString().trim();
				if(validJSON(playlists) || playlists.toString().trim() === "") {
					let currentPlaylists = {};

					if(playlists.toString().trim() !== "") {
						currentPlaylists = JSON.parse(playlists.toString());
					}

					if(name in currentPlaylists) {
						delete currentPlaylists[name];
						fs.writeFile(playlistsFile, JSON.stringify(currentPlaylists), (error) => {
							if(error) {
								console.log(error);
								localWindow.webContents.send("notify", { title:"Error", description:"Could not write to playlists file.", color:"rgb(40,40,40)", duration:5000 });
							}
							else {
								playlists = JSON.stringify(currentPlaylists);
								sendInfo(false);
								localWindow.webContents.send("notify", { title:"Playlist Deleted", description:"The playlist has been deleted.", color:"rgb(40,40,40)", duration:5000 });
								refreshRemoteSongs = true;
								refreshRemotePlaylists = true;
							}
						});
					}
					else {
						localWindow.webContents.send("notify", { title:"Error", description:"That playlist doesn't exist.", color:"rgb(40,40,40)", duration:5000 });
					}
				}
			}
			else {
				localWindow.webContents.send("notify", { title:"Error", description:"Invalid playlist name.", color:"rgb(40,40,40)", duration:5000 });
			}
		});

		ipcMain.on("renamePlaylist", (error, req) => {
			if(typeof req.current !== "undefined" && req.current.toString().trim() && typeof req.new !== "undefined" && req.new.toString().trim()) {
				let currentName = req.current.toString().trim();
				let newName = req.new.toString().trim();
				if(validJSON(playlists)) {
					let currentPlaylists = JSON.parse(playlists);
					if(currentName in currentPlaylists) {
						if(!(newName in currentPlaylists)) {
							let playlist = currentPlaylists[currentName];
							delete currentPlaylists[currentName];
							currentPlaylists[newName] = playlist;
							fs.writeFile(playlistsFile, JSON.stringify(currentPlaylists), (error) => {
								if(error) {
									localWindow.webContents.send("notify", { title:"Error", description:"Couldn't write to playlist file...", color:"rgb(40,40,40)", duration:5000 });
								}
								else {
									playlists = JSON.stringify(currentPlaylists);
									sendInfo(true);
									localWindow.webContents.send("notify", { title:"Playlist Renamed", description:"The playlist has been renamed.", color:"rgb(40,40,40)", duration:5000 });
									refreshRemoteSongs = true;
									refreshRemotePlaylists = true;
								}
							});
						}
						else {
							localWindow.webContents.send("notify", { title:"Error", description:"A playlist with that name already exists.", color:"rgb(40,40,40)", duration:5000 });
						}
					}
					else{
						localWindow.webContents.send("notify", { title:"Error", description:"A playlist with that name doesn't exist.", color:"rgb(40,40,40)", duration:5000 });
					}
				}
				else {
					localWindow.webContents.send("notify", { title:"Error", description:"Invalid playlist JSON data.", color:"rgb(40,40,40)", duration:5000 });
				}
			}
			else {
				localWindow.webContents.send("notify", { title:"Error", description:"Invalid playlist name.", color:"rgb(40,40,40)", duration:5000 });
			}
		});

		ipcMain.on("playlistAddSong", (error, req) => {
			if(validJSON(settings)) {
				let libraryDirectory = JSON.parse(settings).libraryDirectory;
				if(typeof req.playlist !== "undefined" && req.playlist.toString().trim() !== "" && typeof req.file !== "undefined" && req.file.toString().trim() !== "") {
					let name = req.playlist.toString().trim();
					let file = req.file.toString().trim().replace(libraryDirectory.replaceAll("\\", "/"), "");
					if(validJSON(playlists)) {
						let currentPlaylists = JSON.parse(playlists);
						let playlist = currentPlaylists[name];
						let playlistSongs = playlist.songs;
						if(!playlistSongs.includes(file)) {
							currentPlaylists[name].songs.push(file);
							fs.writeFile(playlistsFile, JSON.stringify(currentPlaylists), (error) => {
								if(error) {
									localWindow.webContents.send("notify", { title:"Error", description:"Couldn't write to playlist file...", color:"rgb(40,40,40)", duration:5000 });
								}
								else {
									playlists = JSON.stringify(currentPlaylists);
									sendInfo(true);
									localWindow.webContents.send("notify", { title:"Song Added", description:"The song has been added to the playlist.", color:"rgb(40,40,40)", duration:5000 });
									refreshRemoteSongs = true;
									refreshRemotePlaylists = true;
								}
							});
						}
						else {
							localWindow.webContents.send("notify", { title:"Error", description:"That playlist already has that song.", color:"rgb(40,40,40)", duration:5000 });
						}
					}
					else {
						localWindow.webContents.send("notify", { title:"Error", description:"Invalid playlist JSON data.", color:"rgb(40,40,40)", duration:5000 });
					}
				}
				else {
					localWindow.webContents.send("notify", { title:"Error", description:"Invalid playlist name or audio file.", color:"rgb(40,40,40)", duration:5000 });
				}
			}
			else {
				localWindow.webContents.send("notify", { title:"Error", description:"Invalid settings. Try resetting them.", color:"rgb(40,40,40)", duration:5000 });
			}
		});

		ipcMain.on("playlistRemoveSong", (error, req) => {
			if(typeof req.playlist !== "undefined" && req.playlist.toString().trim() !== "" && typeof req.file !== "undefined" && req.file.toString().trim() !== "") {
				let name = req.playlist.toString().trim();
				let file = req.file.toString().trim();
				if(validJSON(playlists)) {
					let currentPlaylists = JSON.parse(playlists);
					let index = currentPlaylists[name].songs.indexOf(file);
					if(index > -1) {
						currentPlaylists[name].songs.splice(index, 1);
						fs.writeFile(playlistsFile, JSON.stringify(currentPlaylists), (error) => {
							if(error) {
								localWindow.webContents.send("notify", { title:"Error", description:"Couldn't write to playlist file...", color:"rgb(40,40,40)", duration:5000 });
							}
							else {
								playlists = JSON.stringify(currentPlaylists);
								sendInfo(true);
								localWindow.webContents.send("notify", { title:"Song Removed", description:"The song has been removed from the playlist.", color:"rgb(40,40,40)", duration:5000 });
								refreshRemoteSongs = true;
								refreshRemotePlaylists = true;
							}
						});
					}
					else {
						localWindow.webContents.send("notify", { title:"Error", description:"Could not find that song in that playlist.", color:"rgb(40,40,40)", duration:5000 });
					}
				}
			}
			else {
				localWindow.webContents.send("notify", { title:"Error", description:"Invalid playlist name or audio file.", color:"rgb(40,40,40)", duration:5000 });
			}
		});

		ipcMain.on("resetSettings", (error, req) => {
			fs.writeFile(settingsFile, defaultSettings, (error) => {
				if(error) {
					console.log(error);
					localWindow.webContents.send("notify", { title:"Error", description:"Couldn't write to settings file.", color:"rgb(40,40,40)", duration:5000 });
				}
				else {
					settings = defaultSettings;
					sendInfo(false);
					localWindow.webContents.send("notify", { title:"Reset", description:"Your settings have been reset.", color:"rgb(40,40,40)", duration:5000 });
					refreshRemoteSongs = true;
					refreshRemotePlaylists = true;
				}
			});
		});

		ipcMain.on("openFileLocation", (error, req) => {
			if(validJSON(settings)) {
				let libraryDirectory = JSON.parse(settings).libraryDirectory;
				if(libraryDirectory.includes("\\")) {
					req = req.replaceAll("/", "\\");
				}
				if(req.includes(libraryDirectory)) {
					shell.showItemInFolder(path.resolve(req));
				}
				else {
					localWindow.webContents.send("notify", { title:"Error", description:"Access not authorized.", color:"rgb(40,40,40)", duration:5000 });
				}
			}
			else {
				localWindow.webContents.send("notify", { title:"Error", description:"Invalid settings. Try resetting them.", color:"rgb(40,40,40)", duration:5000 });
			}
		});

		ipcMain.on("minimizeApp", (error, req) => {
			localWindow.minimize();
		});

		ipcMain.on("maximizeApp", (error, req) => {
			if(process.platform === "darwin") {
				localWindow.isFullScreen() ? localWindow.setFullScreen(false) : localWindow.setFullScreen(true);
			}
			else {
				localWindow.isMaximized() ? localWindow.restore() : localWindow.maximize();
			}
		});

		ipcMain.on("quitApp", (error, req) => {
			(process.platform === "darwin") ? app.hide() : app.quit();
		});

		appExpress.set("views", path.join(__dirname, "views"));
		appExpress.set("view engine", "ejs");
		appExpress.use("/assets", express.static(path.join(__dirname, "assets")));
		appExpress.use(body_parser.urlencoded({ extended:true }));
		appExpress.use(body_parser.json({ limit:"1mb" }));

		appExpress.get("/", (req, res) => {
			if(remoteCheck()) {
				res.render("remote");
			}
		});

		appExpress.post("/remotePlaySong", (req, res) => {
			if(remoteCheck()) {
				localWindow.webContents.send("remotePlaySong", JSON.stringify(req.body));
				res.send("done");
			}
		});

		appExpress.post("/playSong", (req, res) => {
			if(remoteCheck()) {
				let type = mime.lookup(req.body.file).toLowerCase();
				if(type === "audio/mpeg" || type === "audio/x-wav" || type === "audio/ogg" || type === "application/ogg") {
					fs.readFile(req.body.file, function(error, file) {
						let base64 = Buffer.from(file).toString("base64");
						res.send(JSON.stringify({ base64:base64, mime:type }));
					});
				}
			}
		});

		appExpress.get("/resumeSong", (req, res) => {
			if(remoteCheck()) {
				localWindow.webContents.send("resumeSong");
				res.send("done");
			}
		});

		appExpress.get("/pauseSong", (req, res) => {
			if(remoteCheck()) {
				localWindow.webContents.send("pauseSong");
				res.send("done");
			}
		});

		appExpress.get("/stopSong", (req, res) => {
			if(remoteCheck()) {
				localWindow.webContents.send("stopSong");
				res.send("done");
			}
		});

		appExpress.get("/playPreviousSong", (req, res) => {
			if(remoteCheck()) {
				localWindow.webContents.send("playPreviousSong");
				res.send("done");
			}
		});

		appExpress.get("/playNextSong", (req, res) => {
			if(remoteCheck()) {
				localWindow.webContents.send("playNextSong");
				res.send("done");
			}
		});

		appExpress.post("/setSlider", (req, res) => {
			if(remoteCheck()) {
				localWindow.webContents.send("setSlider", req.body.slider);
				res.send("done");
			}
		});

		appExpress.post("/setVolume", (req, res) => {
			if(remoteCheck()) {
				localWindow.webContents.send("setVolume", req.body.volume);
				res.send("done");
			}
		});

		appExpress.get("/setLoop", (req, res) => {
			if(remoteCheck()) {
				localWindow.webContents.send("setLoop");
				res.send("done");
			}
		});

		// Used to synchronize the remote's app with the host.
		appExpress.get("/checkStatus", (req, res) => {
			if(remoteCheck()) {
				localWindow.webContents.send("setStatus");
				res.send(currentStatus);
			}
		});

		// Used to synchronize the host's app with the remote.
		appExpress.post("/setView", (req, res) => {
			if(remoteCheck()) {
				localWindow.webContents.send("setView", req.body);
				res.send("done");
			}
		});

		appExpress.post("/getSongs", (req, res) => {
			if(req.body.force) {
				refreshRemoteSongs = true;
			}
			if(remoteCheck() && refreshRemoteSongs) {
				if(validJSON(settings)) {
					let libraryDirectory = JSON.parse(settings).libraryDirectory;
					if(libraryDirectory !== "") {
						glob(libraryDirectory + "/**/*.{mp3, wav, ogg}", (error, files) => {
							if(error) {
								console.log(error);
							}
							else {
								let songs = [];
								let count = 0;
								files.map(file => {
									metadata.parseFile(file).then(data => {
										let title = data.common.title;
										let artist = data.common.artist;
										let album = data.common.album;
										let duration = data.format.duration;
										if(typeof data.common.title === "undefined" || data.common.title.trim() === "") {
											title = path.basename(file).split(".").slice(0, -1).join(".");
										}
										if(typeof data.common.album === "undefined" || data.common.album.trim() === "") {
											album = "Unknown Album";
										}
										if(typeof data.common.artist === "undefined" || data.common.artist.trim() === "") {
											artist = "Unknown Artist";
										}
										songs.push({ file:file, title:title, artist:artist, album:album, duration:duration });
										count++;
										if(count === files.length) {
											res.send(songs);
											refreshRemoteSongs = false;
										}
									}).catch(error => {
										console.log(error);
									});
								});
							}
						});
					}
					else {
						res.send("");
					}
				}
			}
			else {
				res.send("done");
			}
		});

		appExpress.get("/getInfo", (req, res) => {
			if(remoteCheck()) {
				let info = { ip:ip.address(), localPort:localPort, appPort:appPort, settings:settings, playlists:playlists, forceUpdate:true };
				res.send(info);
			}
		});

		appExpress.get("/getPlaylists", (req, res) => {
			if(req.body.force) {
				refreshRemotePlaylists = true;
			}
			if(remoteCheck() && refreshRemotePlaylists) {
				res.send(playlists);
				refreshRemotePlaylists = false;
			}
			else {
				res.send("done");
			}
		});

		function sendInfo(forced) {
			let info = { ip:ip.address(), localPort:localPort, appPort:appPort, settings:settings, playlists:playlists, forceUpdate:forced };
			localWindow.webContents.send("getInfo", info);
		}

		function remoteCheck() {
			if(validJSON(settings)) {
				return JSON.parse(settings).allowRemote;
			}
			else {
				return true;
			}
		}

		function changeSettings(key, value) {
			let currentSettings = fs.readFileSync(settingsFile, { encoding:"utf-8" }).toString();
			if(validJSON(currentSettings)) {
				let current = JSON.parse(currentSettings);
				current[key] = value;
				fs.writeFile(settingsFile, JSON.stringify(current), function(error) {
					if(error) {
						console.log(error);
						localWindow.webContents.send("notify", { title:"Error", description:"Couldn't write to settings file.", color:"rgb(40,40,40)", duration:5000 });
					}
					else {
						settings = JSON.stringify(current);
						sendInfo(false);
					}
				});
			}
		}
	}
	else {
		dialog.showMessageBoxSync({ title:"Error", message:"Could not create the required user files." });
		app.quit();
	}
});

String.prototype.replaceAll = function(str1, str2, ignore) {
	return this.replace(new RegExp(str1.replace(/([\/\,\!\\\^\$\{\}\[\]\(\)\.\*\+\?\|\<\>\-\&])/g,"\\$&"),(ignore?"gi":"g")),(typeof(str2)=="string")?str2.replace(/\$/g,"$$$$"):str2);
}

function validJSON(json) {
	try {
		let object = JSON.parse(json);
		if(object && typeof object === "object") {
			return object;
		}
	}
	catch(e) { }
	return false;
}
