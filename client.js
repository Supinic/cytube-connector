module.exports = (function () {
	const EventEmitter = require("events");
	const SocketIO = require("socket.io-client");
	const got = require("got");

	const mandatoryConstructorOptions = ["chan", "host", "port", "user"];
	const handlers = [ "disconnect",
		/*
		 These are from CyTube /src/user.js
		 */
		"announcement",
		"clearVoteskipVote",
		"kick",
		"login",
		"setAFK",

		/*
		 Current list as of 2017-06-04
		 The following command was used to get this list from CyTube /src/channel/
		 $> ( spot emit && spot broadcastAll ) \
		 | awk {"print $2"} | sed "s/"/\n"/g" \
		 | grep """ | grep -Pi "[a-z]" | sort -u
		 */
		"addFilterSuccess",
		"addUser",
		"banlist",
		"banlistRemove",
		"cancelNeedPassword",
		"changeMedia",
		"channelCSSJS",
		"channelNotRegistered",
		"channelOpts",
		"channelRankFail",
		"channelRanks",
		"chatFilters",
		"chatMsg",
		"clearchat",
		"clearFlag",
		"closePoll",
		"cooldown",
		"costanza",
		"delete",
		"deleteChatFilter",
		"drinkCount",
		"emoteList",
		"empty",
		"errorMsg",
		"listPlaylists",
		"loadFail",
		"mediaUpdate",
		"moveVideo",
		"needPassword",
		"newPoll",
		"noflood",
		"playlist",
		"pm",
		"queue",
		"queueFail",
		"queueWarn",
		"rank",
		"readChanLog",
		"removeEmote",
		"renameEmote",
		"searchResults",
		"setCurrent",
		"setFlag",
		"setLeader",
		"setMotd",
		"setPermissions",
		"setPlaylistLocked",
		"setPlaylistMeta",
		"setTemp",
		"setUserMeta",
		"setUserProfile",
		"setUserRank",
		"spamFiltered",
		"updateChatFilter",
		"updateEmote",
		"updatePoll",
		"usercount",
		"userLeave",
		"userlist",
		"validationError",
		"validationPassed",
		"voteskip",
		"warnLargeChandump",
	];

	class CytubeConnector extends EventEmitter {
		#chan;
		#host;
		#port;
		#user;

		#agent = "cytube-client";
		#auth = null;
		#connected = false;
		#killswitch = null;
		#handlersAssigned = false;
		#pass = null;
		#secure = true;
		#socket = null;
		#socketURL = null;

		constructor (options) {
			super();

			for (const option of mandatoryConstructorOptions) {
				if (!options[option]) {
					throw new Error(`Parameter "${option}" is required`);
				}
			}

			this.#chan = options.chan;
			this.#host = options.host;
			this.#port = options.port;
			this.#user = options.user;

			this.#secure = options.secure ?? true;
			this.#pass = options.pass ?? null;
			this.#auth = options.auth ?? null;

			this.once("ready", () => {
				this.connect();
				this.emit("clientinit");
			}).once("connected", () => {
				this.start();
				this.emit("clientready");
			}).once("started", () => {
				if (typeof this.assignLateHandlers === "function") {
					this.assignLateHandlers();
				}
			});

			this.getSocketURL();
		}

		async getSocketURL () {
			let data = null;
			try {
				data = await got({
					useFullResponse: true,
					url: `${this.#secure ? "https" : "http"}://${this.#host}:${this.#port}/socketconfig/${this.#chan}.json`,
					headers: {
						"User-Agent": this.#agent
					},
					timeout: 20.0e3
				}).json();
			}
			catch (e) {
				this.emit("error", new Error("Socket lookup failure", e));
				return;
			}

			const servers = [...data.servers];
			while (servers.length) {
				const server = servers.pop();
				if (server.secure === this.#secure && typeof server.ipv6 === "undefined") {
					this.#socketURL = server.url;
				}
			}

			if (!this.#socketURL) {
				this.emit("error", new Error("No suitable socket available"));
				return;
			}
			
			this.emit("ready");
		}

		connect () {
			if (this.#socket) {
				this.#socket.close();
				this.#socket = null;
			}

			this.emit("connecting");
			this.#socket = SocketIO(this.#socketURL)
				.on("error", (err) => this.emit("error", new Error(err)))
				.once("connect", () => {
					if (!this.#handlersAssigned) {
						this.assignHandlers();
						this.#handlersAssigned = true;
					}
					this.#connected = true;
					this.emit("connected");
				});

			return this;
		}

		start () {
			// this.console.log("Connecting to channel.");
			this.#socket.emit("joinChannel", { name: this.#chan });
			this.emit("starting");

			this.#socket.once("needPassword", () => {
				if (typeof this.#pass !== "string") {
					this.emit("error", new Error("Channel requires password"));
					return;
				}
				
				this.#socket.emit("channelPassword", this.#pass);
			});

			this.#killswitch = setTimeout(() => {
				this.emit("error", new Error("Channel connection failure - no response within 60 seconds"));
			}, 60.0e3);

			this.#socket.once("login", (data) => {
				if (typeof data === "undefined") {
					this.emit("error", new Error("Malformed login frame recieved"));
					return;
				}

				if (!data.success) {
					this.emit("error", new Error("Channel login failure", JSON.stringify(data)));
				}
				else {
					this.emit("started");

					clearTimeout(this.#killswitch);
					this.#killswitch = null;
				}
			});

			this.#socket.once("rank", () => {
				this.#socket.emit("login", {
					name: this.#user,
					pw: this.#auth
				});
			});

			return this;
		}

		assignHandlers () {
			handlers.forEach(frame => {
				this.#socket.on(frame, (...args) => {
					this.emit(frame, ...args);
				});
			});
		}

		destroy () {
			if (this.#socket) {
				this.#socket.disconnect(0);
				this.#socket = null;
			}
		}
		
		get socket () { return this.#socket; }
	}

	Object.assign(CytubeConnector.prototype, {
		// Messages
		chat: function (chatMsg) {
			this.socket.emit("chatMsg", chatMsg);
		},
		pm: function (privMsg) {
			this.socket.emit("pm", privMsg);
		},

		// Polls
		createPoll: function (poll) {
			this.socket.emit("newPoll", poll);
		},
		closePoll: function () {
			this.socket.emit("closePoll");
		},

		// Channel Control
		sendOptions: function (opts) {
			this.socket.emit("setOptions", opts);
		},
		sendPermissions: function (perms) {
			this.socket.emit("setPermissions", perms);
		},
		sendBanner: function (banner) {
			this.socket.emit("setMotd", banner);
		},

		// Bans
		bans: function () {
			this.socket.emit("requestBanlist");
		},
		unban: function (ban) {
			this.socket.emit("unban", ban);
		},

		// Media Control
		leader: function (leader) {
			this.socket.emit("assignLeader", leader);
		},
		deleteVideo: function (uid) {
			this.socket.emit("delete", uid);
		},
		move: function (pos) {
			this.socket.emit("moveMedia", pos);
		},
		jump: function (uid) {
			this.socket.emit("jumpTo", uid);
		},
		shuffle: function () {
			this.socket.emit("shufflePlaylist");
		},
		playlist: function () {
			this.socket.emit("requestPlaylist");
		}
	});

	return CytubeConnector;
})();