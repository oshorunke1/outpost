--!strict
-- Checks the Lune transport the contract runner uses. Its request function is faked here, so this
-- spec never touches the network. The real scheduler is used, so the timeout is a real timer.
local Serde = require("@lune/serde")
local Task = require("@lune/task")
local Harness = require("@Tests/Harness")
local BackendClient = require("@Logic/Backend/BackendClient")
local LuneTransport = require("@Tests/Support/LuneTransport")

local Describe = Harness.Describe
local It = Harness.It
local Expect = Harness.Expect

type Seen = { Params: any, Warnings: { string } }

-- A transport whose request function hands back Answer, or runs it when it is a function.
local function Rig(Answer: any, Seconds: number?): (BackendClient.Transport, Seen)
	local Seen: Seen = { Params = nil, Warnings = {} }
	local Send = LuneTransport.new({
		Request = function(Params: any): any
			Seen.Params = Params
			if type(Answer) == "function" then
				return Answer()
			end
			return Answer
		end,
		ConfigSeconds = Seconds or 5,
		Warn = function(Message: string)
			table.insert(Seen.Warnings, Message)
		end,
	})
	return Send, Seen
end

local function Post(Body: any?): BackendClient.TransportRequest
	return {
		Method = "POST",
		Url = "http://backend.test/v1/economy/transactions",
		Headers = { Authorization = "Bearer abc", ["Idempotency-Key"] = "contract-key-0001" },
		Body = Body,
		TimeoutSeconds = 5,
	}
end

Describe("LuneTransport", function()
	It("sends the url, method, headers and a JSON body to net.request", function()
		local Send, Seen = Rig({ ok = true, statusCode = 201, headers = {}, body = "{}" })
		Send(Post({ kind = "earn", amount = 30 }))
		Expect(Seen.Params.url).ToBe("http://backend.test/v1/economy/transactions")
		Expect(Seen.Params.method).ToBe("POST")
		Expect(Seen.Params.headers.Authorization).ToBe("Bearer abc")
		Expect(Seen.Params.headers["Idempotency-Key"]).ToBe("contract-key-0001")
		Expect(Serde.decode("json", Seen.Params.body)).ToEqual({ kind = "earn", amount = 30 })
	end)

	It("sends no body when the request has none", function()
		local Send, Seen = Rig({ ok = true, statusCode = 200, headers = {}, body = "{}" })
		Send(Post(nil))
		Expect(Seen.Params.body).ToBeNil()
	end)

	It("hands back the status, a decoded body and lowercase header names", function()
		local Send = Rig({
			ok = true,
			statusCode = 200,
			headers = { ["Idempotent-Replayed"] = "true", ["Retry-After"] = "2" },
			body = '{"replayed":true,"balanceAfter":30}',
		})
		local Response = Send(Post({}))
		Expect(Response.Ok).ToBe(true)
		Expect(Response.Status).ToBe(200)
		Expect(Response.Body).ToEqual({ replayed = true, balanceAfter = 30 })
		Expect(Response.Headers["idempotent-replayed"]).ToBe("true")
		Expect(Response.Headers["retry-after"]).ToBe("2")
		Expect(Response.Headers["Idempotent-Replayed"]).ToBeNil()
	end)

	It("a refusal keeps its status and an empty or broken body comes back as nil", function()
		local Empty = Rig({ ok = false, statusCode = 404, headers = {}, body = "" })(Post({}))
		Expect(Empty.Ok).ToBe(false)
		Expect(Empty.Status).ToBe(404)
		Expect(Empty.Body).ToBeNil()
		local Broken = Rig({ ok = false, statusCode = 502, headers = {}, body = "<html>" })(Post({}))
		Expect(Broken.Status).ToBe(502)
		Expect(Broken.Body).ToBeNil()
	end)

	It("a request that throws is Status 0 and warns, it never throws itself", function()
		local Send, Seen = Rig(function()
			error("connection refused")
		end)
		local Response = Send(Post({}))
		Expect(Response.Status).ToBe(0)
		Expect(Response.Ok).ToBe(false)
		Expect(#Seen.Warnings).ToBe(1)
	end)

	It("a request that hangs gives up on a real timer and answers Status 0", function()
		local Send, Seen = Rig(function()
			Task.wait(5)
			return { ok = true, statusCode = 200, headers = {}, body = "{}" }
		end, 0.05)
		local Started = os.clock()
		local Response = Send(Post({}))
		Expect(Response.Status).ToBe(0)
		Expect(os.clock() - Started < 1).ToBe(true)
		Expect(string.find(Seen.Warnings[1], "took over", 1, true) ~= nil).ToBe(true)
	end)

	It("waits no longer than the time the call has left", function()
		local Send = Rig(function()
			Task.wait(5)
			return { ok = true, statusCode = 200, headers = {}, body = "{}" }
		end, 30)
		local Request = Post({})
		Request.TimeoutSeconds = 0.05
		local Started = os.clock()
		Expect(Send(Request).Status).ToBe(0)
		Expect(os.clock() - Started < 1).ToBe(true)
	end)
end)

return nil
