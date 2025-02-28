import { EventEmitter } from "node:events";
import { io, Socket } from "socket.io-client";

type ConnectorOptions = {
	chan: string;
	host: string;
	user: string;
	port: number;

	secure?: boolean;
	pass?: string | null;
	auth?: string | null;

	agent?: string;
};

type SocketConfigResponse = {
	servers: Array<{
		url: string;
		secure: boolean;
		ipv6?: boolean;
	}>;
};

const handlers = [
	"disconnect",
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
	"warnLargeChandump"
];

export type UserObject = {
	name: string;
	meta: {
		afk: boolean;
		muted: boolean;
		smuted?: boolean;
		aliases?: string[];
		ip?: string;
	};
	profile: {
		image: string;
		text: string;
	};
	rank: number;
};

type Media = {
	duration: string;
	id: string;
	meta: Record<string, unknown>;
	seconds: number;
	title: string;
	type: string;
};
export type VideoObject = {
	media: Media;
	queueby: UserObject["name"];
	temp: boolean;
	uid: number;
};
export type QueueObject = {
	after: VideoObject["uid"] | "prepend";
	item: {
		media: Media;
		temp: boolean;
		queueby: UserObject["name"];
		uid: VideoObject["uid"];
	};
};
export type MessageObject = {
	username: UserObject["name"];
	msg: string;
	meta: {
		private?: boolean;
		shadow?: boolean;
	};
	time: number;
};
export type EmoteObject = {
	name: string;
	image?: string;
	source: string;
};
export type RenameEmoteObject = {
	name: string;
	old: string;
	image?: string;
	source: string;
};

export interface CytubeConnector {
	on (event: "clientready", listener: () => void): this;
	on (event: "changeMedia", listener: () => void): this;
	on (event: "disconnect", listener: () => void): this;

	on (event: "error", listener: (e: Error) => void): this;

	on (event: "userlist", listener: (userList: UserObject[]) => void): this;
	on (event: "playlist", listener: (videoList: VideoObject[]) => void): this;
	on (event: "emoteList", listener: (emoteList: EmoteObject[]) => void): this;

	on (event: "chatMsg", listener: (data: MessageObject) => void): this;
	on (event: "pm", listener: (data: MessageObject) => void): this;
	on (event: "queue", listener: (data: QueueObject) => void): this;
	on (event: "addUser", listener: (data: UserObject) => void): this;
	on (event: "userLeave", listener: (data: UserObject) => void): this;
	on (event: "delete", listener: (data: VideoObject) => void): this;
	on (event: "updateEmote", listener: (data: EmoteObject) => void): this;
	on (event: "renameEmote", listener: (data: RenameEmoteObject) => void): this;
	on (event: "removeEmote", listener: (data: EmoteObject) => void): this;
}

export class CytubeConnector extends EventEmitter {
	#host;
	#port;
	#chan;
	#secure;

	#user;
	#pass;
	#auth;

	#agent;
	#socket: Socket | null = null;

	constructor (options: ConnectorOptions) {
		super();

		this.#host = options.host;
		this.#port = options.port;
		this.#chan = options.chan;
		this.#user = options.user;

		this.#secure = options.secure ?? true;
		this.#pass = options.pass ?? null;
		this.#auth = options.auth ?? null;

		this.#agent = options.agent ?? "cytube-client";
	}

	get socket () {
		if (!this.#socket) {
			throw new Error("Not connected");
		}

		return this.#socket;
	}

	get initialized () {
		return (this.#socket !== null);
	}

	async getSocketURL () {
		const url = `${this.#secure ? "https" : "http"}://${this.#host}:${this.#port}/socketconfig/${this.#chan}.json`;
		const controller = new AbortController();
		const signal = controller.signal;

		const abortTimeout = setTimeout(() => controller.abort("Request timeout"), 20_000);
		const response = await fetch(url, {
			signal,
			headers: {
				"Content-Type": "application/json",
				"User-Agent": this.#agent
			}
		});

		clearTimeout(abortTimeout);

		const data = await response.json() as SocketConfigResponse;
		const applicableServer = data.servers.find(i => i.secure === this.#secure);
		if (!applicableServer) {
			throw new Error("No suitable socket available");
		}

	 	return applicableServer.url;
	}

	async connect () {
		if (this.#socket) {
			this.destroy();
		}

		const socketURL = await this.getSocketURL();
		this.emit("connecting");

		const socket = io(socketURL)
			.on("error", (err) => this.emit("error", err))
			.once("connect", () => {
				for (const frame of handlers) {
					socket.on(frame, (...args) => {
						this.emit(frame, ...args);
					});
				}

				this.emit("connected");
			});

		socket.emit("joinChannel", { name: this.#chan });
		this.emit("starting");

		socket.once("needPassword", () => {
			if (typeof this.#pass !== "string") {
				this.emit("error", new Error("Channel requires password"));
				return;
			}

			socket.emit("channelPassword", this.#pass);
		});

		const killswitch = setTimeout(() => {
			this.emit("error", new Error("Channel connection failure - no response within 60 seconds"));
		}, 60_000);

		socket.once("login", (data) => {
			if (typeof data === "undefined") {
				this.emit("error", new Error("Malformed login frame recieved"));
				return;
			}

			if (!data.success) {
				this.emit("error", new Error("Channel login failure"));
			}
			else {
				this.emit("started");
				clearTimeout(killswitch);
			}
		});

		socket.once("rank", () => {
			socket.emit("login", {
				name: this.#user,
				pw: this.#auth
			});
		});

		this.#socket = socket;
		return this;
	}

	destroy () {
		if (this.#socket) {
			this.#socket.disconnect();
			this.#socket = null;
		}
	}

	chat (chatMessage: string) {
		this.socket.emit("chatMsg", chatMessage);
	}

	pm (privateMessage: string) {
		this.socket.emit("pm", privateMessage);
	}

	// User list
	getUserList () {
		this.socket.emit("userlist");
	}

	// Polls
	createPoll (pollName: string) {
		this.socket.emit("newPoll", pollName);
	}

	closePoll () {
		this.socket.emit("closePoll");
	}

	// Channel Control
	sendOptions (opts: unknown) {
		this.socket.emit("setOptions", opts);
	}

	sendPermissions (perms: unknown) {
		this.socket.emit("setPermissions", perms);
	}

	sendBanner (banner: string) {
		this.socket.emit("setMotd", banner);
	}

	// Bans
	bans () {
		this.socket.emit("requestBanlist");
	}

	unban (ban: string) {
		this.socket.emit("unban", ban);
	}

	// Media Control
	leader (leader: string) {
		this.socket.emit("assignLeader", leader);
	}

	deleteVideo (uid: string) {
		this.socket.emit("delete", uid);
	}

	move (pos: number) {
		this.socket.emit("moveMedia", pos);
	}

	jump (uid: string) {
		this.socket.emit("jumpTo", uid);
	}

	shuffle () {
		this.socket.emit("shufflePlaylist");
	}

	playlist () {
		this.socket.emit("requestPlaylist");
	}
}

export default CytubeConnector;
