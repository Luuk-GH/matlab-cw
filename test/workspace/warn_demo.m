function warn_demo
% A warning from a nested function: its backtrace has more than one frame (all of it must show yellow).
inner();
end

function inner
warning('mcw:demo', 'mcw demo warning');
end
