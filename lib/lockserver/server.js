"use strict";

var
	events	= require('events'),
	util	= require('util'),
	net	= require('net'),

	Stream	= require('./stream').Stream,

	DEBUG	= false,
	first	= null;



function Server(opts){

	// Options

	if ( opts == null )
		opts = {};

	// Variable properties

	this.port				= opts.port			|| 1922;

	// Handlers

	this._s					= null;

	// Data

	this.clients			= {};
	this.requests			= {};
	this.locks				= {};

	// Methods

	this.start				= start;
	this._serverSocketStart	= _serverSocketStart;

	this._clientInit		= _clientInit;
	this._clientNewID		= _clientNewID;
	this._clientNewPingTime	= _clientNewPingTime;
	this._clientDestroy		= _clientDestroy;
	this._clientMessage		= _clientMessage;

	this._requestRemove		= _requestRemove;
	this._lockRegister		= _lockRegister;
	this._lockUnregister	= _lockUnregister;

	this._command			= _command;
	this._answer			= _answer;
	this._send				= _send;
	this._error				= _error;

	// Debug

	if ( opts.DEBUG )
		DEBUG = true;

};


/*
 * Server
 */

// Server start

function start() {

	var
		self = this;

	_debug("INFO:\tStarting...");

	// Start server

	self._serverSocketStart();

}


// Start socket server

function _serverSocketStart(handler) {

	var
		self = this;

	self._s = net.createServer(function(con){ self._clientInit(con) });
	self._s.listen(self.port, function(){
		_debug("INFO:\tListening\n");

		// Watch ping times

//		self._pingCheckInterval = setInterval(function(){ self._pingCheck() },10000);

		if ( handler )
			return handler();
	});

}


/*
 * Client
 */

// Client initialization

function _clientInit(con) {

	var
		self = this,
		c;

	con._id = this._clientNewID();
	c = this.clients[con._id] = {
		// Low level stuff
		id: con._id,
		con: con,
		connectTime: new Date(),
		pingTime: self._clientNewPingTime(),

		// Stream
		stream: new Stream("string",con),

		// High level stuff
		status: "new",
		requests: {}
	};
	con.on('error',function(err){
		_debug("ERROR:\tClient "+c.id+" connection error: ",err);
		if ( err.code == 'EPIPE' )
			return self._clientDestroy(c);
	});
	c.stream.on('message',function(msg){
		self._clientMessage(c,msg);
	});
	c.stream.on('close',function(){
		self._clientDestroy(c);
	});
	c.stream.on('end',function(){
		self._clientDestroy(c);
	});
	c.stream.on('error',function(err,cantRecover){
		_error(c,err);
		if ( cantRecover )
			self._clientDestroy(c);
	});

	_debug("INFO:\tClient "+c.id+" connected");

}

// Generate new clint ID

function _clientNewID() {

	var
		d = new Date(),
		id;

	do {
		id = "C"+d.getTime().toString() + "." + Math.floor(Math.random()*1001);
	} while ( this.clients[id] != null );

	return id;

}

// New ping time

function _clientNewPingTime() {

	return new Date((new Date()).getTime()+30000);

}


// Handle client message (highlevel stuff)

function _clientMessage(c,msg) {

	var
		self = this,
		m;

	try {
		m = JSON.parse(msg.toString('utf8'));
//		_debug(c.id+" > ",JSON.stringify(m));
	}
	catch(ex) {
		_debug("ERROR:\tClient "+c.id+" sent invalid JSON. Parsing exception: ",ex);
		_debug("ERROR:\tOriginal was: ",msg.toString('utf8'));
		return;
	}

	// Update ping time

	c.pingTime = self._clientNewPingTime();


	// Lock command

	if ( m.command == "lock" ) {

		// Validation

		if ( !m.id )
			return self._answer(c,"lock",{error: { code: "ENOID", description: "No request id was supplied" }});
		if ( !m.name && (!m.names || !(m.names instanceof Array)) ) {
			console.log(m);
			return self._answer(c,"lock",{error: { code: "ENONAME", description: "Lock should have a name or name list" }});
		}
		if ( !m.timeout )
			return self._answer(c,"lock",{error: { code: "ENOTO", description: "Lock should have a timeout" }});

		// Something registered for this used with the same ID ? (this should not happen but..)

		if ( self.requests[c.id+"/"+m.id] )
			return self._answer(c,"lock",{error: { code: "ELAEX", description: "A lock with the same ID made by you already exists", id: c.id+"/"+m.id }});

		// Register the lock
		if ( self._lockRegister(c,m.id,m.names||[m.name],m.timeout) == false ) {
			_debug("INFO:\tTelling to client "+c.id+" request "+m.id+" that he can run");
			return self._answer(c,"lock",{ id: m.id, ok: true });
		}
		else if ( m.iflock )
			return self._answer(c,"lock",{ id: m.id, islocked: true });

	}
	else if ( m.command == "unlock" ) {

		// Validation
		if ( !m.id )
			return self._answer(c,"unlock",{error: { code: "ENOID", description: "No request id was supplied" }});

		if ( !self.requests[c.id+"/"+m.id] )
			return self._answer(c,"unlock",{error: { code: "ENOENT", description: "A lock with the specified id does not exist", id: c.id+"/"+m.id }});

		if ( self._lockUnregister(c,m.id) )
			return self._answer(c,"unlock",{id: m.id, ok: true});
		else
			return self._answer(c,"unlock",{error: { code: "ENOCUR", description: "You are not the current owner of the lock" }});

	}
	else if ( m.command == "dump" ) {
		console.log(util.inspect({clients: self.clients, requests: self.requests, locks: self.locks},{depth:2}));
		return self._answer(c,"dump",{ok: true});
	}
	else {
		_debug("WARN:\tUnknown command on: ",m);
		return self._error(c,{ code: "EUNKNCMD", description: "Unknown command", command: m.command });
	}

}



// Destroy a client

function _clientDestroy(c) {

	var
		self = this;

	// Status

	if ( c.status == "dead" )
		return;
	c.status = "dead";

	_debug("INFO:\tClient "+c.id+" has disconnected");

	// Unlock the locks that client was inside
	// Remove all pending requests from this client
	_debug("INFO:\tTOTAL requests: ",Object.keys(c.requests).length);
	for ( var id in c.requests ) {
		var r = c.requests[id];
		if ( r.status == "running" )
			self._lockUnregister(c,r.originalID,true);
		self._requestRemove(r);
	}

	// Destroy connection

	c.con.destroy();

	// Destroy client

	delete self.clients[c.id];

}



/*
 * Biz
 */

// Remove a request

function _requestRemove(request) {

	var
		self = this,
		req = (typeof(request) == "string") ? self.requests[request] : request;

	// Remove from request table

	delete self.requests[req.id];

	// Remove from lock table

	if ( req.name != null ) {
		for ( var x = 0 ; x < self.locks[req.name].length ; x++ ) {
			if ( self.locks[req.name][x].id == req.id ) {
				self.locks[req.name].splice(x,1);
				break;
			}
		}
	}

	// Remove from client request table

	delete req.client.requests[req.originalID];

	return true;

}

// Register a lock
function _lockRegister(c,id,names,timeout) {

	var
		self 	= this,
		rid  	= c.id+"/"+id,
		req  	= { client: c, id: rid, originalID: id, timeoutVal: timeout, names: names, status: "waiting", waitingCount: 0 },
		toLock	= [];

	_debug("INFO:\tRegistering request "+rid+" for locking '"+names.join(', ')+"'");
	self.requests[rid] = req;
	c.requests[id] = req;

	// Update waitingCount and register locks on the lock table
	names.forEach(function(name){
		if ( self.locks[name] ) {
			req.waitingCount++;
			self.locks[name].push(req);
		}
		else
			self.locks[name] = [req];
	});
	if ( req.waitingCount == 0 ) {
		req.status = "running";
		return false;
	}

	// Lock and define a timeout for waiting for unlock
	req.timeout = setTimeout(function(){
		if ( req.status != "waiting" )
			return;

		_debug("INFO:\tRequest #"+rid+" timed out (after "+req.timeoutVal+"ms waiting) - status: ",req.status);
		req.status = "timeout";
		return self._answer(c,"lock",{ id: id, ok: false, error: { code: "ETIMEOUT", description: "Lock timed out" } });

	}, req.timeoutVal);

	return true;

}

// Unregister a lock (unlock)
function _lockUnregister(c,id,disconnect) {

	var
		self		= this,
		rid			= c.id+"/"+id,
		req			= self.requests[rid],
		lockNames	= req.names,
		goToNext	= [],
		freeLocks	= [];

	_debug("INFO:\tClient unlock on request ID "+rid+", locks '"+lockNames.join(', ')+"' owned by "+req.client.id+(disconnect ? " due to client disconnect":""));

	// Some validations
	lockNames.forEach(function(lockName){
		if ( !self.locks[lockName] )
			_debug("ERROR:\tClient "+c.id+" wants to unlock a lock that doen't exist? ("+lockName+"). Coherence problem?");
		if ( !self.locks[lockName] )
			_debug("ERROR:\tClient "+c.id+" wants to unlock '"+lockName+"' but he doen't own the lock. Coherence problem?");
	});

	_debug("INFO:\tUnlocking '"+lockNames.join(', ')+"' ...");

	req.status = "done";
	req.name = null;
	if ( req.timeout )
		clearTimeout(req.timeout);

	// Remove processed request from locks table
	lockNames.forEach(function(lockName){
		if ( !self.locks[lockName] )
			return;
		var locks = self.locks[lockName];
		for ( var x = 0 ; x < locks.length ; x++ ) {
			if ( locks[x].id == req.id ) {
				locks.splice(x,1);
				_debug("INFO:\tLocks on "+lockName+": ",locks.length);
				if ( x == 0 ) {
					if ( locks.length > 0 )
						goToNext.push(lockName);
					else
						freeLocks.push(lockName);
					break;
				}
				x--;
			}
		}
	});
	self._requestRemove(req);

	// Locks to free
	freeLocks.forEach(function(lockName){
		_debug("INFO:\tLock '"+lockName+"' is now free.");
		delete self.locks[lockName];
	});

	// Locks still with requests on the list? Make them run
	goToNext.forEach(function(lockName){
		_debug("INFO:\tLock '"+lockName+"' still has "+self.locks[lockName].length+" requests waiting...");

		var next = self.locks[lockName][0];
		while ( next && (next.status == "timeout" || next.status == "dead") ) {
			_debug("WARN:\tSkipping 1 request from lock '"+lockName+"' because had '"+next.status+"' status");
			delete self.requests[next.id];
			self.locks[lockName].shift();
			delete c.requests[next.originalID];
			next = self.locks[lockName][0];
		}
		if ( !next ) {
			_debug("WARN:\tLock '"+lockName+"' is free (all pending requests timed out/dead).");
			delete self.locks[lockName];
			return true;
		}

		// Tell to next that he can go!
		next.waitingCount--;
		if ( next.waitingCount == 0 ) {
			_debug("INFO:\tTelling to client "+next.client.id+" request "+next.originalID+" that he can now run on lock "+lockName+" ...");
			next.status = "running";
			if ( next.timeout )
				clearTimeout(next.timeout);

			self._answer(next.client,"lock",{ id: next.originalID, ok: true });
		}
	});

	// Delete client request
	delete self.requests[req.id];
	delete c.requests[req.originalID];

	return true;

}



/*
  Sockets
 */

function _send(c,obj) {
//	console.log(c.id+" < ",JSON.stringify(obj));
	return c.stream.sendMessage(JSON.stringify(obj));
}
function _command(c,command,args) {
	var
		o = args || { };

	this.lastCommand = command;
	o.command = command;
	this._send(c,o);
}
function _answer(c,to,args) {
	args.to = to;
	return this._command(c,"answer",args);
}
function _error(c,error) {
	return this._send(c,{ error: error });
}


/*
  Utils
 */

// Clone an object

 function clone(obj) {
	if (null == obj || "object" != typeof obj) return obj;
	var copy = obj.constructor();
	for (var attr in obj)
		if (obj.hasOwnProperty(attr)) copy[attr] = obj[attr];
	return copy;
}


// Number format

function _nf(val,pad,base) {
	var xval = val;
	if ( base != null )
		xval = xval.toString(base);
	if ( pad ) {
		var padding = "";
		for ( var x = 0 ; x < pad ; x++ )
			padding += "0";
		return String(padding + xval).slice(-pad);
	}
	return xval;
}

// Async condition

function _cond(cond,cb1,final) {
	return cond ? cb1(final) : final();
}

// Debug

function _debug() {

	if ( !DEBUG )
		return;

	var
		moment = _nsec(first).toString(),
		args = [];

	for ( var x = moment.length ; x < 15 ; x++ )
		moment += " ";

	args.push("@"+moment);
	for ( var x = 0 ; x < arguments.length ; x++ )
		args.push(arguments[x]);

	console.log.apply(console,args);
}

function _nsec(start) {
	if ( first == null )
		start = first = process.hrtime();

	var
		diff = process.hrtime(start);

	return (diff[0] * 1e9 + diff[1]) / 1000000;
}


// I export myself!

module.exports = Server;
