var bytewise = require('bytewise');
var Transform = require('readable-stream/transform');
var Readable = require('readable-stream/readable');
var foreignKey = require('foreign-key');

module.exports = Assoc;
function Assoc (db) {
    if (!(this instanceof Assoc)) return new Assoc(db);
    this.db = db;
    this._sublevel = db.sublevel('assoc');
    this._foreign = {};
    this._has = [];
    this._hasKeys = {};
    
    var self = this;
    db.hooks.post({ start: '', end: '~' }, function (change) {
        if (change.type === 'put') {
            var value = typeof change.value === 'string'
                ? JSON.parse(change.value)
                : change.value
            ;
            self._postPut(change.key, value, function (err) {
                if (err) self.db.emit('error', err)
            });
        }
        else if (change.type === 'del') {
            // ignore deletes; compaction happens on stream key lookup errors
        }
    });
}

Assoc.prototype.add = function (key) {
    this._foreign[key] = foreignKey([ 'type', key ]);
    this._hasKeys[key] = {};
    
    var self = this;
    return new Type(function (k, type) {
        self._has.push([ type, k, key ]);
        self._hasKeys[key][k] = type;
        self._foreign[key].add(k, type, key);
    });
};

Assoc.prototype._postPut = function (key, value, cb) {
    if (!value) return cb();
    var self = this;
    
    var pending = 1;
    
    var k = bytewise.encode([ value.type, key ]).toString('hex');
    this._sublevel.put(k, 0, function (err) {
        if (err) cb(err)
        else if (--pending === 0) cb()
    });
    
    for (var i = 0, li = this._has.length; i < li; i++) {
        var ts = this._has[i][0];
        var cur = value;
        for (var cur, j = 0, lj = ts.length - 1; j < lj; j++) {
            cur = cur[ts[j]];
            if (cur === undefined) break;
        }
        if (j !== lj || cur !== ts[j]) continue;
        
        var topKey = this._has[i][2];
        var fkey = [ null, topKey ]
            .concat(this._foreign[topKey].keyList(key, value))
        ;
        
        pending ++;
        
        var k = bytewise.encode(fkey).toString('hex');
        this._sublevel.put(k, 0, function (err) {
            if (err) cb(err)
            else if (--pending === 0) cb()
            
        });
    }
    
    if (pending === 0) cb();
};

Assoc.prototype.get = function (topKey, cb) {
    var self = this;
    if (!cb) cb = function () {};
    var row;
    
    this.db.get(topKey, function (err, row_) {
        if (err) return cb(err);
        row = row_;
        self._augment(row, topKey);
        cb(null, row);
    });
    
    return { createStream: createStream };
    
    function createStream () {
        var rs = new Readable;
        var fkeys, stream, first = true, sfirst;
        var busy = false;
        
        rs._read = function () {
            if (!fkeys) return;
            if (!stream && fkeys.length === 0) {
                rs.push('}');
                return rs.push(null);
            }
            
            if (!stream) {
                var key = fkeys.shift();
                var skey = JSON.stringify(key);
                rs.push((first ? skey : ',' + skey) + ':[');
                first = false;
                stream = row[key]();
                stream.on('finish', function () {
                    stream = null;
                    rs.push(']');
                });
                sfirst = true;
            }
            
            var x = stream.read();
            if (x) ready()
            else stream.once('readable', function () {
                x = stream.read();
                if (x) ready();
            });
            
            function ready () {
                var s = JSON.stringify(x);
                rs.push(sfirst ? s : ',' + s);
                sfirst = false;
            }
        };
        
        if (!row) {
            var cb_ = cb;
            cb = function (err, row_) {
                if (err) rs.emit('error', err)
                else begin()
                cb_.apply(this, arguments);
            };
        }
        else begin()
        return rs;
        
        function begin () {
            fkeys = [];
            rs.push('{' + Object.keys(row).map(function (key) {
                if (typeof row[key] === 'function') {
                    fkeys.push(key);
                    return false;
                }
                first = false;
                return JSON.stringify(key) + ':' + JSON.stringify(row[key]);
            }).filter(Boolean).join(','));
        }
    }
};

Assoc.prototype._augment = function (row, topKey) {
    var self = this;
    var keyTypes = this._hasKeys[row.type];
    Object.keys(keyTypes).forEach(function (key) {
        var type = keyTypes[key];
        row[key] = function () {
            return self._rowStream(row.type, topKey, key);
        };
    });
};

Assoc.prototype._rowStream = function (topType, topKey, key) {
    var self = this;
    var start = [ null, topType, topKey, key ];
    var end = [ null, topType, topKey, key, undefined ];
    
    var opts = {
        start: bytewise.encode(start).toString('hex'),
        end: bytewise.encode(end).toString('hex')
    };
    var tr = new Transform({ objectMode: true });
    tr._transform = function (row, enc, next) {
        var parts = bytewise.decode(Buffer(row.key, 'hex'));
        self.db.get(parts[4], function (err, value) {
            
            if ((err && err.name === 'NotFoundError')
            || (value && value[topType] !== topKey)) {
                // lazily remove deleted or stale indexes
                self._sublevel.del(row.key);
                return next();
            }
            else if (err) return next(err);
            tr.push({ key: parts[4], value: value });
            next();
        });
    };
    tr._flush = function (next) {
        next();
    };
    return self._sublevel.createReadStream(opts).pipe(tr);
};

Assoc.prototype.list = function (type, params, cb) {
    var self = this;
    if (typeof params === 'function') {
        cb = params;
        params = {};
    }
    if (!params) params = {};
    
    var opts = {
        start: bytewise.encode([ type, null ]).toString('hex'),
        end: bytewise.encode([ type, undefined ]).toString('hex')
    };
    var tr = new Transform({ objectMode: true });
    
    tr._transform = function (row, enc, next) {
        var key = bytewise.decode(Buffer(row.key, 'hex'));
        
        self.db.get(key[1], function (err, value) {
            if ((err && err.name === 'NotFoundError')
            || (value && value.type !== type)) {
                self._sublevel.del(row.key);
                return next();
            }
            else if (err) return next(err);
            
            if (params.augment !== false) self._augment(value, key[1]);
            
            tr.push({ key: key[1], value: value });
            next();
        });
    };
    
    if (cb) {
        var results = [];
        tr.on('error', cb);
        tr.on('data', function (row) { results.push(row) });
        tr.on('end', function () { cb(null, results) });
    }
    
    return this._sublevel.createReadStream(opts).pipe(tr);
};

function Type (cb) {
    this._cb = cb;
}

Type.prototype.hasMany = function (key, type) {
    if (typeof type === 'string') type = [ 'type', type ];
    this._cb(key, type);
    return this;
};

Type.prototype.belongsTo = function (type, key) {
    if (key === undefined && typeof type === 'string') key = [ type ];
    if (typeof type === 'string') type = [ 'type', type ];
    if (key === undefined) throw new Error(
        '`key` cannot be inferred with a non-string type.'
        + ' Specify a key.'
    );
    return this;
};
