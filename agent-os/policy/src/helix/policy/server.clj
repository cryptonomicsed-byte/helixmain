(ns helix.policy.server
  "The HTTP face of the policy service.

    POST /v1/decide   helix-policy-request/1  ->  the decision
    GET  /health      200 when a valid policy is loaded, 503 when it is not
    GET  /v1/policy   which policy is in force (id, version, rule ids)

  Strict by construction: JSON only, one document, bounded size and depth,
  UTF-8, no keep-alive tricks, no CORS. It binds to loopback by default; the
  kernel runs beside it. A request that is JSON but not a valid
  helix-policy-request/1 is answered 200 with a DENY (and says why); a body that
  is not one JSON document is 400."
  (:require [clojure.data.json :as json]
            [clojure.string :as str]
            [helix.policy.core :as core]
            [helix.policy.holder :as holder])
  (:import (com.sun.net.httpserver HttpExchange HttpHandler HttpServer)
           (java.io ByteArrayOutputStream PushbackReader StringReader)
           (java.net InetSocketAddress)
           (java.nio.charset StandardCharsets)
           (java.util.concurrent ArrayBlockingQueue ThreadPoolExecutor ThreadPoolExecutor$CallerRunsPolicy TimeUnit)))

(def max-body-bytes (* 256 1024))
(def max-depth 64)

(defn- bytes-of [^String s] (.getBytes s StandardCharsets/UTF_8))

(defn- respond!
  [^HttpExchange ex status body-map]
  (let [bs (bytes-of (json/write-str body-map :escape-unicode true :escape-slash false))]
    (doto (.getResponseHeaders ex)
      (.set "Content-Type" "application/json; charset=utf-8")
      (.set "Cache-Control" "no-store")
      (.set "X-Content-Type-Options" "nosniff"))
    (.sendResponseHeaders ex status (alength bs))
    (with-open [o (.getResponseBody ex)] (.write o bs))))

(defn- read-body
  "At most max-body-bytes, or nil when the body is larger."
  [^HttpExchange ex]
  (let [declared (some-> (.getFirst (.getRequestHeaders ex) "Content-Length") parse-long)]
    (when-not (and declared (> declared max-body-bytes))
      (with-open [in (.getRequestBody ex)]
        (let [out (ByteArrayOutputStream.)
              buf (byte-array 8192)]
          (loop [total 0]
            (let [n (.read in buf)]
              (cond
                (neg? n) (.toByteArray out)
                (> (+ total n) max-body-bytes) nil
                :else (do (.write out buf 0 n) (recur (+ total n)))))))))))

(defn nesting-depth
  "Deepest [ / { nesting outside of strings. Cheap and independent of the JSON
  parser, so a hostile document is refused before anything recurses on it."
  [^String s]
  (loop [i 0 depth 0 deepest 0 in-str false esc false]
    (if (>= i (count s))
      deepest
      (let [c (.charAt s i)]
        (cond
          in-str (cond esc (recur (inc i) depth deepest true false)
                       (= c \\) (recur (inc i) depth deepest true true)
                       (= c \") (recur (inc i) depth deepest false false)
                       :else (recur (inc i) depth deepest true false))
          (= c \") (recur (inc i) depth deepest true false)
          (or (= c \[) (= c \{)) (let [d (inc depth)] (recur (inc i) d (max d deepest) false false))
          (or (= c \]) (= c \})) (recur (inc i) (dec depth) deepest false false)
          :else (recur (inc i) depth deepest false false))))))

(defn parse-json
  "One JSON document, nothing after it. Returns [:ok value] or [:error why]."
  [^bytes bs]
  (let [s (try (.toString (.decode (-> StandardCharsets/UTF_8 .newDecoder
                                       (.onMalformedInput java.nio.charset.CodingErrorAction/REPORT)
                                       (.onUnmappableCharacter java.nio.charset.CodingErrorAction/REPORT))
                                   (java.nio.ByteBuffer/wrap bs)))
               (catch java.nio.charset.CharacterCodingException _ nil))]
    (cond
      (nil? s) [:error "body is not valid UTF-8"]
      (> (nesting-depth s) max-depth) [:error "JSON is nested too deeply"]
      :else
      (try
        (let [r (PushbackReader. (StringReader. s) 64)
              v (json/read r)]
          (loop []
            (let [c (.read r)]
              (cond
                (neg? c) [:ok v]
                (Character/isWhitespace (char c)) (recur)
                :else [:error "unexpected content after the JSON document"]))))
        (catch Exception e [:error (str "body is not valid JSON: " (.getMessage e))])
        (catch StackOverflowError _ [:error "JSON is nested too deeply"])))))

(defn- json-content-type? [^HttpExchange ex]
  (let [ct (.getFirst (.getRequestHeaders ex) "Content-Type")]
    (boolean (and ct (re-matches #"(?i)\s*application/json\s*(;.*)?" ct)))))

(defn- log! [m] (println (json/write-str m :escape-unicode true)) (flush))

(defn- decide-handler [h]
  (reify HttpHandler
    (handle [_ ex]
      (try
        (cond
          (not= "POST" (.getRequestMethod ex))
          (do (.set (.getResponseHeaders ex) "Allow" "POST")
              (respond! ex 405 {"error" "use POST"}))

          (not (json-content-type? ex))
          (respond! ex 415 {"error" "Content-Type must be application/json"})

          :else
          (if-let [bs (read-body ex)]
            (let [[tag v] (parse-json bs)]
              (if (= :error tag)
                (respond! ex 400 {"error" v})
                (let [{:keys [policy error]} (holder/current h)
                      answer (if policy
                               (core/safe-decide policy v)
                               {"decision" "deny" "matched_rule" ""
                                "reason_codes" ["policy_invalid"]
                                "reason" (str "no valid policy is loaded: " error)
                                "policy_version" "" "matched_rules" []})]
                  (log! {"event" "decision"
                         "intent" (some-> v (get "intent") (get "id") str)
                         "decision" (get answer "decision")
                         "matched_rule" (get answer "matched_rule")
                         "reason_codes" (get answer "reason_codes")
                         "policy_version" (get answer "policy_version")})
                  (respond! ex 200 answer))))
            (respond! ex 413 {"error" (str "body is larger than " max-body-bytes " bytes")})))
        (catch Throwable t
          (log! {"event" "error" "error" (.getSimpleName (class t))})
          (try (respond! ex 500 {"error" "internal error"}) (catch Throwable _ nil)))
        (finally (.close ex))))))

(defn- health-handler [h]
  (reify HttpHandler
    (handle [_ ex]
      (try
        (if (not= "GET" (.getRequestMethod ex))
          (respond! ex 405 {"error" "use GET"})
          (let [{:keys [policy error]} (holder/current h)]
            (if policy
              (respond! ex 200 {"status" "ok" "policy_id" (:id policy) "policy_version" (:version policy)})
              (respond! ex 503 {"status" "degraded" "error" error}))))
        (catch Throwable _ (try (respond! ex 500 {"error" "internal error"}) (catch Throwable _ nil)))
        (finally (.close ex))))))

(defn- policy-handler [h]
  (reify HttpHandler
    (handle [_ ex]
      (try
        (if (not= "GET" (.getRequestMethod ex))
          (respond! ex 405 {"error" "use GET"})
          (let [{:keys [policy error]} (holder/current h)]
            (if policy
              (respond! ex 200 {"id" (:id policy) "version" (:version policy) "sha256" (:sha256 policy)
                                "rules" (mapv (fn [r] {"id" (:id r) "decision" (name (:decision r)) "reason_code" (:reason-code r)}) (:rules policy))})
              (respond! ex 503 {"error" error}))))
        (catch Throwable _ (try (respond! ex 500 {"error" "internal error"}) (catch Throwable _ nil)))
        (finally (.close ex))))))

(defn start
  "Starts the service and returns {:server .. :port ..}. `port` 0 picks a free one."
  [{:keys [policy-file host port check-interval-ms] :or {host "127.0.0.1" port 8181 check-interval-ms 1000}}]
  ;; Slow-client protection for the JDK server: give up on a request that takes
  ;; more than 10 s to arrive and a response that takes more than 30 s to leave.
  (System/setProperty "sun.net.httpserver.maxReqTime" "10")
  (System/setProperty "sun.net.httpserver.maxRspTime" "30")
  (let [h (holder/open policy-file check-interval-ms)
        server (HttpServer/create (InetSocketAddress. ^String host (int port)) 128)
        pool (ThreadPoolExecutor. 4 16 30 TimeUnit/SECONDS (ArrayBlockingQueue. 64) (ThreadPoolExecutor$CallerRunsPolicy.))]
    (.createContext server "/v1/decide" (decide-handler h))
    (.createContext server "/health" (health-handler h))
    (.createContext server "/v1/policy" (policy-handler h))
    (.setExecutor server pool)
    (.start server)
    {:server server :pool pool :holder h :port (.getPort (.getAddress server))}))

(defn stop [{:keys [^HttpServer server ^ThreadPoolExecutor pool]}]
  (.stop server 1)
  (.shutdown pool))
