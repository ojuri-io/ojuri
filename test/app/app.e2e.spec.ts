import Build from "../../src/app";

const app = new Build();

describe("App", () => {
  afterAll(() => {
    app.close();
  });

  test("/ (GET)", async () => {
    const response = await app.getInstance().inject({
      method: "GET",
      url: "/",
    });

    expect(response.statusCode).toEqual(200);
   
  });
});
